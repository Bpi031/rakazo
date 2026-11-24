import type { CheckpointService } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  CheckpointBranchRename,
  CheckpointCreate,
  CheckpointRename,
  CheckpointRollback,
} from "@rakazo/contracts";
import type { Context, Hono } from "hono";
import { isAllowedWebOrigin } from "./web-origins.js";

export function mountCheckpointHttp(
  app: Hono,
  deps: {
    service: Pick<
      CheckpointService,
      "status" | "list" | "create" | "rename" | "rollback" | "audit"
    >;
    actor: (request: Request) => Promise<Actor | null>;
    webOrigin: string;
    additionalWebOrigins?: readonly string[];
  },
) {
  const handle = async (c: Context) => {
    c.header("cache-control", "no-store");
    const actor = await deps.actor(c.req.raw);
    if (!actor) return c.json({ error: "Sign in required" }, 401);
    try {
      const route = new URL(c.req.url).pathname;
      const botId = c.req.query("botId") ?? "";
      if (c.req.method === "GET" && route === "/api/checkpoints/status")
        return c.json(await deps.service.status(actor, botId));
      if (c.req.method === "GET" && route === "/api/checkpoints")
        return c.json(await deps.service.list(actor, botId));
      if (c.req.method === "GET" && route === "/api/checkpoints/audit") {
        c.header("content-disposition", 'attachment; filename="checkpoint-audit.json"');
        return c.json(await deps.service.audit(actor, botId));
      }
      if (
        c.req.method !== "POST" ||
        !isAllowedWebOrigin(c.req.header("origin"), deps) ||
        !c.req.header("content-type")?.startsWith("application/json")
      )
        return c.json({ error: "Same-origin JSON operation required" }, 403);
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.json({ error: "JSON required" }, 400);
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8192) {
            await reader.cancel();
            return c.json({ error: "Request too large" }, 413);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (route === "/api/checkpoints")
        return c.json(await deps.service.create(actor, CheckpointCreate.parse(body)), 201);
      const branch = /^\/api\/checkpoints\/branches\/([^/]+)\/rename$/.exec(route);
      if (branch) {
        const input = CheckpointBranchRename.parse(body);
        if (input.branchId !== branch[1]) return c.json({ error: "Branch does not match" }, 400);
        return c.json(await deps.service.rename(actor, input));
      }
      const rename = /^\/api\/checkpoints\/([^/]+)\/rename$/.exec(route);
      if (rename) {
        const input = CheckpointRename.parse(body);
        if (input.checkpointId !== rename[1])
          return c.json({ error: "Checkpoint does not match" }, 400);
        return c.json(await deps.service.rename(actor, input));
      }
      const match = /^\/api\/checkpoints\/([^/]+)\/rollback$/.exec(route);
      if (match) {
        const input = CheckpointRollback.parse(body);
        if (input.checkpointId !== match[1])
          return c.json({ error: "Checkpoint does not match" }, 400);
        const result = await deps.service.rollback(actor, input);
        return c.json(result, result.ok ? 200 : 409);
      }
      return c.json({ error: "Not found" }, 404);
    } catch {
      return c.json(
        { error: "Checkpoint operation rejected. Refresh and check workspace status." },
        409,
      );
    }
  };
  app.all("/api/checkpoints", handle);
  app.all("/api/checkpoints/*", handle);
}
