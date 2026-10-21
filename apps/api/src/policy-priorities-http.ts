import type { Hono } from "hono";
import type { Actor } from "@rakazo/contracts";
import { PriorityService, prioritySchemas } from "@rakazo/adapters";
import { isAllowedWebOrigin } from "./web-origins.js";

export function mountPriorityHttp(app: Hono, deps: {
  service: Pick<PriorityService, "inspect" | "current" | "review" | "get" | "apply">;
  actor: (request: Request) => Promise<Actor | null>;
  verifyPassword: (request: Request, password: string) => Promise<boolean>;
  webOrigin: string;
  additionalWebOrigins?: readonly string[];
}) {
  const confirmations = new Map<string, { time: number; count: number }>();
  app.all("/api/rule-priorities/*", async (c) => {
    c.header("cache-control", "no-store");
    const actor = await deps.actor(c.req.raw);
    if (!actor) return c.json({ error: "Sign in required" }, 401);
    try {
      const route = new URL(c.req.url).pathname.slice("/api/rule-priorities/".length);
      if (c.req.method === "GET" && route === "current") return c.json(await deps.service.current(actor, c.req.query("botId") ?? ""));
      if (c.req.method === "GET" && route.startsWith("review/")) return c.json(await deps.service.get(actor, route.slice(7)));
      if (c.req.method !== "POST" || !isAllowedWebOrigin(c.req.header("origin"), deps) ||
          !c.req.header("content-type")?.startsWith("application/json")) return c.json({ error: "Same-origin JSON operation required" }, 403);
      const reader = c.req.raw.body?.getReader(); if (!reader) return c.json({ error: "JSON required" }, 400);
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 65536) { await reader.cancel(); return c.json({ error: "Review request is too large" }, 413); } chunks.push(value);
      } } finally { reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (route === "inspect") return c.json(await deps.service.inspect(actor, prioritySchemas.inspect.parse(body)));
      if (route === "review") return c.json(await deps.service.review(actor, prioritySchemas.review.parse(body)));
      if (route === "apply") {
        if (c.req.header("authorization") || !c.req.header("cookie")) return c.json({ error: "Browser session required" }, 403);
        const now = Date.now(); const previous = confirmations.get(actor.userId);
        for (const [user, value] of confirmations) if (now - value.time > 60000) confirmations.delete(user);
        if ((!previous && confirmations.size >= 1000) || previous && now - previous.time <= 60000 && previous.count >= 5)
          return c.json({ error: "Confirmation rate limit reached" }, 429);
        confirmations.set(actor.userId, previous && now - previous.time <= 60000 ? { ...previous, count: previous.count + 1 } : { time: now, count: 1 });
        const input = prioritySchemas.apply.parse(body);
        if (input.phrase !== "CREATE DRAFT " + input.id || !await deps.verifyPassword(c.req.raw, input.password))
          return c.json({ error: "Fresh password and exact draft confirmation required" }, 403);
        return c.json(await deps.service.apply(actor, input.id, input.digest));
      }
      return c.json({ error: "Not found" }, 404);
    } catch {
      return c.json({ error: "Rule review rejected. Reload the policy and review; check source/input drift, supported policy form, expiry and ownership. No solve was started." }, 409);
    }
  });
}
