import type { Hono } from "hono";
import type { Actor } from "@rakazo/contracts";
import { TeamService, teamHttpSchemas } from "@rakazo/adapters";
import { isAllowedWebOrigin } from "./web-origins.js";

export function mountDisabledTeamHttp(app: Hono, actor: (request: Request) => Promise<unknown>) {
  app.all("/api/team/*", async (c) => {
    c.header("cache-control", "no-store");
    if (!await actor(c.req.raw)) return c.json({ error: "Sign in required" }, 401);
    return c.json({ code: "TEAM_DISABLED", error: "Team administration is not enabled on this deployment." }, 503);
  });
}

export function mountTeamHttp(app: Hono, deps: {
  service: TeamService;
  actor: (request: Request) => Promise<Actor | null>;
  verifyPassword: (request: Request, password: string) => Promise<boolean>;
  webOrigin: string;
  additionalWebOrigins?: readonly string[];
  administrationEnabled?: boolean;
}) {
  const attempts = new Map<string, { at: number; count: number }>();
  app.all("/api/team/*", async (c) => {
    c.header("cache-control", "no-store");
    try {
      const actor = await deps.actor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const url = new URL(c.req.url); const route = url.pathname.slice("/api/team/".length);
      if (deps.administrationEnabled === false && !["overview","directory","inbox","request","inbox/decide","invite/accept"].includes(route))
        return c.json({ code: "TEAM_DISABLED", error: "Administration requires the operator's team storage boundary" }, 503);
      if (c.req.method === "GET") {
        if (route === "overview") return c.json(await deps.service.overview(actor));
        if (route === "actions") return c.json(await deps.service.proposals(actor));
        if (route === "inbox") return c.json(await deps.service.inbox(actor));
        if (route === "directory") return c.json(await deps.service.directory(actor));
        return c.json({ error: "Not found" }, 404);
      }
      if (c.req.method !== "POST" || !isAllowedWebOrigin(c.req.header("origin"), deps)
          || !c.req.header("content-type")?.startsWith("application/json"))
        return c.json({ error: "Same-origin JSON operation required" }, 403);
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.json({ error: "JSON body required" }, 400);
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 16_384) { await reader.cancel(); return c.json({ error: "Request too large" }, 413); }
        chunks.push(value); } } finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw);
      if (route === "propose") return c.json(await deps.service.propose(actor, teamHttpSchemas.propose.parse(body).action, "dashboard"));
      if (route === "request") {
        const input = teamHttpSchemas.request.parse(body);
        return c.json(await deps.service.request(actor, input.botId, input.recipientUserId, input.message, input.key, input.recipientBotId));
      }
      if (route === "invite/accept") return c.json(await deps.service.acceptInvite(actor, teamHttpSchemas.acceptInvite.parse(body).token));
      if (route === "confirm" || route === "inbox/decide") {
        if (c.req.header("authorization") || !c.req.header("cookie")) return c.json({ error: "Browser session required" }, 403);
        const bucket = attempts.get(actor.userId);
        const now = Date.now();
        if (attempts.size >= 1000 && !bucket) {
          for (const [key, value] of attempts) if (now - value.at > 60_000) attempts.delete(key);
          if (attempts.size >= 1000) return c.json({ error: "Confirmation capacity reached" }, 429);
        }
        if (bucket && now - bucket.at < 60_000 && bucket.count >= 5) return c.json({ error: "Confirmation rate limit" }, 429);
        attempts.set(actor.userId, bucket && now - bucket.at < 60_000 ? { ...bucket, count: bucket.count + 1 } : { at: now, count: 1 });
        if (attempts.size > 1000) for (const [key, value] of attempts) if (now - value.at > 60_000) attempts.delete(key);
        if (typeof body.password !== "string" || body.password.length > 1024 || !await deps.verifyPassword(c.req.raw, body.password))
          return c.json({ error: "Fresh account-password confirmation required" }, 403);
        if (route === "confirm") {
          const input = teamHttpSchemas.confirm.parse(body);
          if (input.phrase !== "APPLY " + input.id) return c.json({ error: "Exact confirmation phrase required" }, 400);
          return c.json(await deps.service.confirm(actor, input.id, input.digest));
        }
        const input = teamHttpSchemas.decide.parse(body);
        return c.json(await deps.service.decideRequest(actor, input.id, input.accept, input.botId));
      }
      return c.json({ error: "Not found" }, 404);
    } catch {
      // Do not expose Prisma errors, private filesystem paths or request contents.
      return c.json({ error: "Operation rejected. Check role, target state, current review, quota service and active work." }, 409);
    }
  });
}
