import type { CheckpointService } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { CheckpointCreate, CheckpointRollback } from "@rakazo/contracts";
import { CheckpointConflictError, IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { isAllowedWebOrigin } from "./web-origins.js";

const legacyRollback = CheckpointRollback.omit({ expectedRevision: true });

function invalidCheckpoint(c: Context) {
  return c.json({ code: "CHECKPOINT_INVALID_REQUEST", error: "Invalid checkpoint request." }, 400);
}

export function mountCheckpointHttp(
  app: Hono,
  deps: {
    service: Pick<CheckpointService, "status" | "list" | "create" | "rollback" | "audit">;
    actor: (request: Request) => Promise<Actor | null>;
    webOrigin: string;
    additionalWebOrigins?: readonly string[];
  },
) {
  const handle = async (c: Context) => {
    c.header("cache-control", "no-store");
    try {
      const actor = await deps.actor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const route = new URL(c.req.url).pathname;
      if (c.req.method === "GET") {
        if (
          !["/api/checkpoints/status", "/api/checkpoints", "/api/checkpoints/audit"].includes(route)
        )
          return c.json({ error: "Not found" }, 404);
        const botId = CheckpointCreate.shape.botId.safeParse(c.req.query("botId"));
        if (!botId.success) return invalidCheckpoint(c);
        if (route === "/api/checkpoints/status")
          return c.json(await deps.service.status(actor, botId.data));
        if (route === "/api/checkpoints") return c.json(await deps.service.list(actor, botId.data));
        const audit = await deps.service.audit(actor, botId.data);
        c.header("content-disposition", 'attachment; filename="checkpoint-audit.json"');
        return c.json(audit);
      }
      if (
        c.req.method !== "POST" ||
        !isAllowedWebOrigin(c.req.header("origin"), deps) ||
        !c.req.header("content-type")?.startsWith("application/json")
      )
        return c.json({ error: "Same-origin JSON operation required" }, 403);
      const reader = c.req.raw.body?.getReader();
      if (!reader) return invalidCheckpoint(c);
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
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return invalidCheckpoint(c);
      }
      if (route === "/api/checkpoints") {
        const input = CheckpointCreate.safeParse(body);
        if (!input.success) return invalidCheckpoint(c);
        const saved = await deps.service.create(actor, input.data);
        return c.json({ id: saved.id }, 201);
      }
      const match = /^\/api\/checkpoints\/([^/]+)\/rollback$/.exec(route);
      if (match) {
        const input = CheckpointRollback.safeParse(body);
        if (!input.success) {
          const legacy = legacyRollback.safeParse(body);
          if (legacy.success && legacy.data.checkpointId === match[1])
            return c.json(
              { code: "CHECKPOINT_STALE", error: "Reload the page before restoring a checkpoint." },
              409,
            );
          return invalidCheckpoint(c);
        }
        if (input.data.checkpointId !== match[1]) return invalidCheckpoint(c);
        const result = await deps.service.rollback(actor, input.data);
        return result.ok
          ? c.json(result, 200)
          : c.json(
              {
                ok: false,
                generation: result.generation,
                code: "CHECKPOINT_RECOVERY_BLOCKED",
                error: "Workspace recovery is incomplete. Choose a checkpoint to retry.",
              },
              409,
            );
      }
      return c.json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof IsolationError)
        return c.json(
          { code: "CHECKPOINT_NOT_FOUND", error: "Checkpoint or workspace not found." },
          404,
        );
      if (error instanceof CheckpointConflictError) {
        if (error.reason === "incomplete")
          return c.json(
            { code: "CHECKPOINT_INCOMPLETE", error: "This checkpoint is missing saved data." },
            409,
          );
        if (error.reason === "stale")
          return c.json(
            { code: "CHECKPOINT_STALE", error: "Workspace changed. Refresh checkpoints." },
            409,
          );
        return c.json(
          { code: "CHECKPOINT_CONFLICT", error: "Workspace is busy or unavailable." },
          409,
        );
      }
      getLogger().error("Unexpected checkpoint request failure");
      return c.json(
        { code: "CHECKPOINT_INTERNAL", error: "The checkpoint operation failed." },
        500,
      );
    }
  };
  app.all("/api/checkpoints", handle);
  app.all("/api/checkpoints/*", handle);
}
