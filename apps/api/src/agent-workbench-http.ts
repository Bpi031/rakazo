import type { Hono } from "hono";
import type { Actor } from "@rakazo/contracts";
import { WorkbenchBrowserInput, NativeDecision } from "@rakazo/contracts";
import type { NativeControl } from "@rakazo/adapters";
import type { AgentWorkbench } from "@rakazo/adapters";
import { isAllowedWebOrigin } from "./web-origins.js";

export function mountAgentWorkbench(
  app: Hono,
  deps: {
    service: AgentWorkbench;
    isDeveloper: (actor:Actor)=>boolean;
    native?: NativeControl;
    actor: (request: Request) => Promise<Actor | null>;
    verifyPassword: (request: Request, password: string) => Promise<boolean>;
    webOrigin: string;
    additionalWebOrigins?: readonly string[];
  },
) {
  const attempts = new Map<string, { at: number; count: number }>();
  app.all("/api/agent-workbench/*", async (c) => {
    c.header("cache-control", "no-store");
    try {
      const actor = await deps.actor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      if(!deps.isDeveloper(actor))return c.json({error:'Developer mode required'},403);
      const url = new URL(c.req.url),
        route = url.pathname.split("/").at(-1);
      if (c.req.method === "GET") {
        const botId = url.searchParams.get("botId");
        if (!botId || botId.length > 160) return c.json({ error: "Owned bot required" }, 400);
        if (route === "view") return c.json(await deps.service.view(actor, botId));
        if (route === "native" && deps.native) return c.json(await deps.native.view(actor, botId));
        const id = url.searchParams.get("id");
        if (route === "detail" && id && /^[a-f0-9-]{36,64}$/.test(id))
          return c.json(await deps.service.detail(actor, botId, id));
        return c.json({ error: "Unknown operation" }, 404);
      }
      if (
        c.req.method !== "POST" ||
        route !== "decide" ||
        c.req.header("authorization") ||
        !c.req.header("cookie") ||
        !isAllowedWebOrigin(c.req.header("origin"), deps) ||
        !c.req.header("content-type")?.startsWith("application/json")
      )
        return c.json({ error: "Same-origin authenticated browser required" }, 403);
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.json({ error: "Body required" }, 400);
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 30000) {
            await reader.cancel();
            return c.json({ error: "Body cap" }, 413);
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const input =
        raw?.operation === "native_settings"
          ? NativeDecision.parse(raw)
          : WorkbenchBrowserInput.parse(raw);
      const now = Date.now();
      for (const [key, old] of attempts) if (now - old.at > 60000) attempts.delete(key);
      const old = attempts.get(actor.userId);
      if ((old?.count ?? 0) >= 10 || (!old && attempts.size >= 1000))
        return c.json({ error: "Workbench operation rate limit" }, 429);
      attempts.set(actor.userId, { at: old?.at ?? now, count: (old?.count ?? 0) + 1 });
      let result: unknown;
      if (input.operation === "native_settings") {
        if (!deps.native) return c.json({ error: "Native capabilities unavailable" }, 409);
        result = await deps.native.decide(actor, input);
      } else if (input.operation === "save_draft") {
        if (!(await deps.verifyPassword(c.req.raw, input.password)))
          return c.json({ error: "Current password required" }, 403);
        result = await deps.service.saveDraft(actor, input.botId, input.id, input.digest);
      } else if (input.operation === "goal")
        result = await deps.service.goal(actor, input.botId, input.revision, input.goal);
      else if (input.operation === "scenario") {
        const row = await deps.service.scenario(
          actor,
          input.botId,
          input.title,
          "browser:" + input.nonce,
        );
        result = { id: row.id };
      } else if (input.operation === "scenario_message")
        result = await deps.service.scenarioMessage(
          actor,
          input.botId,
          input.id,
          input.message,
          input.nonce,
        );
      else if (input.operation === "refresh_skills")
        result = await deps.service.skills(actor, input.botId);
      else result = await deps.service.selectSkill(actor, input.botId, input.id);
      return c.json(result as any);
    } catch {
      return c.json(
        {
          error:
            "Workbench operation was not confirmed. Refresh permissions, source and limits before proceeding. No retry or extra solve was started.",
        },
        409,
      );
    }
  });
}
