import type { ModelCatalogEntry } from "@rakazo/contracts";
import type { Hono } from "hono";
import { managedEffort, managedReasoning } from "@rakazo/adapters";

export const MANAGED_PROVIDER = "codex-foundry";

export function managedCatalog(env: NodeJS.ProcessEnv = process.env): ModelCatalogEntry[] {
  const aliases = (env.CODEX_DEPLOYMENTS ?? "").split(",").map((s) => s.trim());
  if (
    !aliases.length ||
    aliases.length > 4 ||
    new Set(aliases).size !== aliases.length ||
    aliases.some((id) => !/^[A-Za-z0-9_.-]{1,128}$/.test(id))
  )
    throw new Error("Invalid operator model allowlist");
  const labels: unknown = JSON.parse(env.CODEX_MODEL_LABELS ?? "{}");
  if (
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    Object.entries(labels).some(
      ([key, value]) =>
        !aliases.includes(key) ||
        typeof value !== "string" ||
        !value.trim() ||
        value.length > 100 ||
        /[\x00-\x1f\x7f]/.test(value),
    )
  )
    throw new Error("Invalid operator model labels");
  const reasoning = managedReasoning(env);
  return aliases.map((id) => {
    const entry = Object.hasOwn(reasoning, id) ? reasoning[id] : undefined;
    const label = Object.hasOwn(labels, id) ? ((labels as Record<string, string>)[id] ?? id) : id;
    return {
      provider: MANAGED_PROVIDER,
      providerName: "Managed service",
      id,
      label,
      billing: "Operator managed",
      reasoning: !!entry,
      thinkingLevels: entry?.levels ?? [],
      defaultThinkingLevel: entry?.default ?? null,
    };
  });
}

export function managedChoiceAllowed(
  provider: string | null,
  id: string | null,
  thinking: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const selected =
    provider === null && id === null
      ? env.CODEX_DEFAULT_MODEL
      : provider === MANAGED_PROVIDER
        ? id
        : null;
  if (!selected) return provider === null && id === null && thinking == null;
  if (!managedCatalog(env).some((model) => model.id === selected)) return false;
  try {
    managedEffort(selected, thinking, managedReasoning(env));
    return true;
  } catch {
    return false;
  }
}

export function mountManagedServiceGuards(
  app: Hono,
  actor: (request: Request) => Promise<unknown>,
) {
  // Deny credential operations even when called outside the settings UI.
  app.use("*", async (c, next) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname)
        .replace(/\/+/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
    } catch {
      return c.json({ error: "Invalid route" }, 400);
    }
    if (path.startsWith("/rpc/") && path.includes("%"))
      return c.json({ error: "Invalid route" }, 400);
    const modelRead = new Set([
      "/rpc/models/list",
      "/rpc/models/credentials",
      "/rpc/models/backups",
    ]);
    const blocked =
      ((path === "/rpc/models" || path.startsWith("/rpc/models/")) && !modelRead.has(path)) ||
      path === "/rpc/voice" ||
      path.startsWith("/rpc/voice/") ||
      path.startsWith("/api/voice/") ||
      path === "/api/voice" ||
      ((path === "/rpc/memory" || path.startsWith("/rpc/memory/")) &&
        !["/rpc/memory/config", "/rpc/memory/providers", "/rpc/memory/status"].includes(path));
    if (blocked) {
      const authenticated = Boolean(await actor(c.req.raw));
      return c.json(
        { error: authenticated ? "Services are managed by the operator" : "Sign in required" },
        authenticated ? 403 : 401,
      );
    }
    await next();
  });
}
