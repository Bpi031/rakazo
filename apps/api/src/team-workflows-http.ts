import type { Context, Hono } from "hono";
import type { Actor } from "@rakazo/contracts";
import { workflowDecisionSchema, leadershipDecision } from "@rakazo/contracts";
import type { TeamWorkflowService, TeamLeadershipService } from "@rakazo/adapters";
import { isAllowedWebOrigin } from "./web-origins.js";

export function mountTeamWorkflows(
  app: Hono,
  deps: {
    service: TeamWorkflowService;
    actor: (request: Request) => Promise<Actor | null>;
    leadership?: TeamLeadershipService;
    verifyPassword: (request: Request, password: string) => Promise<boolean>;
    webOrigin: string;
    additionalWebOrigins?: readonly string[];
  },
) {
  const attempts = new Map<string, { at: number; count: number }>();
  const handler = async (c: Context) => {
    c.header("cache-control", "no-store");
    try {
      const actor = await deps.actor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const leadership = new URL(c.req.url).pathname.startsWith("/api/team-leadership/");
      if (leadership && !deps.leadership) return c.json({ error: "Leadership unavailable" }, 503);
      const route = new URL(c.req.url).pathname.split("/").at(-1);
      if (c.req.method === "GET" && route === "list")
        return c.json(
          leadership ? await deps.leadership!.list(actor) : await deps.service.list(actor),
        );
      if (
        c.req.method !== "POST" ||
        route !== "decide" ||
        !isAllowedWebOrigin(c.req.header("origin"), deps) ||
        !c.req.header("content-type")?.startsWith("application/json") ||
        c.req.header("authorization") ||
        !c.req.header("cookie")
      )
        return c.json({ error: "Same-origin browser confirmation required" }, 403);
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.json({ error: "JSON required" }, 400);
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 16_384) {
            await reader.cancel();
            return c.json({ error: "Body too large" }, 413);
          }
          chunks.push(item.value);
        }
      } finally {
        reader.releaseLock();
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const input = (leadership ? leadershipDecision : workflowDecisionSchema).parse(raw);
      const now = Date.now();
      for (const [key, value] of attempts) if (now - value.at > 60_000) attempts.delete(key);
      const bucket = attempts.get(actor.userId);
      if ((bucket?.count ?? 0) >= 5 || (!bucket && attempts.size >= 1000))
        return c.json({ error: "Confirmation rate limit" }, 429);
      attempts.set(actor.userId, { at: bucket?.at ?? now, count: (bucket?.count ?? 0) + 1 });
      if (!(await deps.verifyPassword(c.req.raw, input.password)))
        return c.json({ error: "Current account password required" }, 403);
      return c.json(
        leadership
          ? await deps.leadership!.decide(
              actor,
              input.id,
              input.digest,
              leadershipDecision.parse(raw).operation,
            )
          : await deps.service.decide(
              actor,
              input.id,
              input.digest,
              workflowDecisionSchema.parse(raw).operation,
            ),
      );
    } catch {
      return c.json(
        {
          error: "Workflow operation rejected. Refresh permissions, consent and the exact review.",
        },
        409,
      );
    }
  };
  app.all("/api/team-workflows/*", handler);
  app.all("/api/team-leadership/*", handler);
}
