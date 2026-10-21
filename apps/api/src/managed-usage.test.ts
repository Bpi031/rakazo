import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { managedUsage, mountManagedUsage } from "./managed-usage.js";
const actor = { spaceId: "s", userId: "u", role: "owner" } as any;
const env = { CODEX_INFERENCE_BASE_URL: "http://rost-inference:8080/v1" };
const key = "test-only-capability-signing-key-32-bytes";
it("signs only the authenticated user and returns a secret-free budget DTO", async () => {
  const request = vi.fn(async (_url, options) => {
    const token = options.headers.authorization.slice(7);
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())).toMatchObject({ user: "u", space: "s", purpose: "budget" });
    return Response.json({ day: 1, resetsAt: 172800, models: [{ model: "A", calls: 2, outputReserved: 20,
      knownUsageCalls: 1, inputTokens: 11, outputTokens: 4, limits: { calls: 100, output_tokens: 1000 }, secret: "discard-me" }] });
  });
  const result = await managedUsage(actor, env, request as any, key);
  expect(result.models[0]?.calls).toBe(2);
  expect(JSON.stringify(result)).not.toContain("discard-me");
  expect(request).toHaveBeenCalledTimes(1);
  await expect(managedUsage(actor, { CODEX_INFERENCE_BASE_URL: "https://evil.invalid" }, request as any, key)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("denies anonymous reads and sanitizes upstream failure without fallback", async () => {
  const load = vi.fn(async () => { throw new Error("private-provider-key"); });
  const app = new Hono(); mountManagedUsage(app, async () => null, load);
  expect((await app.request("http://test/api/managed-models/usage")).status).toBe(401);
  expect(load).not.toHaveBeenCalled();
  const owned = new Hono(); mountManagedUsage(owned, async () => actor, load);
  const response = await owned.request("http://test/api/managed-models/usage?user=other");
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-provider-key");
  expect(load).toHaveBeenCalledExactlyOnceWith(actor);
});
