import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Actor } from "@rakazo/contracts";
import type { Hono } from "hono";
import { z } from "zod";

const count = z.number().int().nonnegative();
const budgetResponse = z.object({
  day: count,
  resetsAt: count,
  models: z
    .array(
      z.object({
        model: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
        calls: count,
        outputReserved: count,
        knownUsageCalls: count,
        inputTokens: count.nullable(),
        outputTokens: count.nullable(),
        limits: z.object({ calls: count, output_tokens: count }),
      }),
    )
    .max(4),
});

export async function managedUsage(
  actor: Actor,
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
  key = readFileSync(env.CODEX_CAPABILITY_KEY_FILE ?? "/run/secrets/capability_key", "utf8").trim(),
) {
  if (
    Buffer.byteLength(key) < 32 ||
    env.CODEX_INFERENCE_BASE_URL !== "http://rost-inference:8080/v1"
  )
    throw new Error("Budget service unavailable");
  const payload = Buffer.from(
    JSON.stringify({
      space: actor.spaceId,
      user: actor.userId,
      bot: "budget-view",
      run: "budget-view",
      model: "budget-view",
      purpose: "budget",
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  ).toString("base64url");
  const token = payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
  const response = await request(env.CODEX_INFERENCE_BASE_URL + "/budget", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Budget service unavailable");
  const raw = await response.text();
  if (raw.length > 16_384) throw new Error("Invalid budget response");
  const value = budgetResponse.safeParse(JSON.parse(raw));
  if (!value.success) throw new Error("Invalid budget response");
  return value.data;
}

export function mountManagedUsage(
  app: Hono,
  actor: (request: Request) => Promise<Actor | null>,
  load = managedUsage,
) {
  app.get("/api/managed-models/usage", async (c) => {
    c.header("cache-control", "no-store");
    const owner = await actor(c.req.raw);
    if (!owner) return c.json({ error: "Sign in required" }, 401);
    try {
      return c.json(await load(owner));
    } catch {
      return c.json(
        { error: "Model usage is temporarily unavailable. No allowance was renewed." },
        503,
      );
    }
  });
}
