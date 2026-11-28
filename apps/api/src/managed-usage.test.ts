import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { managedUsage, mountManagedUsage } from "./managed-usage.js";

const actor = {
  spaceId: "s",
  userId: "u",
  email: "test@example.invalid",
  isDeploymentOwner: false,
};
const env = { CODEX_INFERENCE_BASE_URL: "http://rost-inference:8080/v1" };
const key = "test-only-capability-signing-key-32-bytes";
it("signs only the authenticated user and returns a secret-free budget DTO", async () => {
  const request = vi.fn<typeof fetch>(async (_url, options) => {
    const token = new Headers(options?.headers).get("authorization")!.slice(7);
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString())).toMatchObject({
      user: "u",
      space: "s",
      purpose: "budget",
    });
    return Response.json({
      day: 1,
      resetsAt: 172800,
      models: [
        {
          model: "A",
          calls: 2,
          outputReserved: 20,
          knownUsageCalls: 1,
          inputTokens: 11,
          outputTokens: 4,
          limits: { calls: 100, output_tokens: 1000 },
          secret: "discard-me",
        },
      ],
    });
  });
  const result = await managedUsage(actor, env, request, key);
  expect(result.models[0]?.calls).toBe(2);
  expect(JSON.stringify(result)).not.toContain("discard-me");
  expect(request).toHaveBeenCalledTimes(1);
  await expect(
    managedUsage(actor, { CODEX_INFERENCE_BASE_URL: "https://evil.invalid" }, request, key),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("denies anonymous reads and sanitizes upstream failure without fallback", async () => {
  const load = vi.fn(async () => {
    throw new Error("private-provider-key");
  });
  const app = new Hono();
  mountManagedUsage(app, async () => null, load);
  expect((await app.request("http://test/api/managed-models/usage")).status).toBe(401);
  expect(load).not.toHaveBeenCalled();
  const owned = new Hono();
  mountManagedUsage(owned, async () => actor, load);
  const response = await owned.request("http://test/api/managed-models/usage?user=other");
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private-provider-key");
  expect(load).toHaveBeenCalledExactlyOnceWith(actor);
});

it("rejects malformed budget rows and counts outside the safe integer range", async () => {
  for (const value of [
    { day: 1, resetsAt: 172800, models: [null] },
    { day: Number.MAX_SAFE_INTEGER + 1, resetsAt: 172800, models: [] },
  ]) {
    const request = vi.fn<typeof fetch>(async () => Response.json(value));
    await expect(managedUsage(actor, env, request, key)).rejects.toThrow("Invalid budget response");
    expect(request).toHaveBeenCalledOnce();
  }
});
