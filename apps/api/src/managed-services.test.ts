import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { managedCatalog, managedChoiceAllowed, mountManagedServiceGuards } from "./managed-services.js";
const env = { CODEX_DEPLOYMENTS: "DeepSeek-V4.1-Flash,GPT-6.1-Sol",
  CODEX_MODEL_LABELS: '{"GPT-6.1-Sol":"GPT 6.1 Sol"}' };
it("publishes and validates only configured effort levels, including space-default overrides", () => {
  const configured = { ...env, CODEX_DEFAULT_MODEL: "DeepSeek-V4.1-Flash", CODEX_MODEL_REASONING: JSON.stringify({
    "DeepSeek-V4.1-Flash": { levels: ["low", "high", "max"], default: "high" },
    "GPT-6.1-Sol": { levels: ["low", "medium", "high", "xhigh", "max", "ultra"], default: "medium" },
  }) };
  expect(managedCatalog(configured)[0]).toMatchObject({ thinkingLevels: ["low", "high", "max"], defaultThinkingLevel: "high" });
  expect(managedChoiceAllowed(null, null, "low", configured)).toBe(true);
  expect(managedChoiceAllowed("codex-foundry", "GPT-6.1-Sol", "ultra", configured)).toBe(true);
  expect(managedChoiceAllowed(null, null, "ultra", configured)).toBe(false);
  expect(managedChoiceAllowed("codex-foundry", "DeepSeek-V4.1-Flash", "medium", configured)).toBe(false);
});
it("publishes only operator labels and exact aliases, never credentials", () => {
  const models = managedCatalog({ ...env, REQUESTY_API_KEY: "must-not-escape" });
  expect(models.map((m) => m.id)).toEqual(env.CODEX_DEPLOYMENTS.split(","));
  expect(models[1]?.label).toBe("GPT 6.1 Sol");
  expect(JSON.stringify(models)).not.toContain("must-not-escape");
  for (const CODEX_DEPLOYMENTS of ["", "a,a", "https://evil", "a,b,c,d,e"]) {
    expect(() => managedCatalog({ CODEX_DEPLOYMENTS })).toThrow();
  }
  expect(() => managedCatalog({ CODEX_DEPLOYMENTS: "a", CODEX_MODEL_LABELS: '{"b":"hidden"}' })).toThrow();
});
it("allows configured per-bot selection or space default, not hidden providers/reasoning", () => {
  expect(managedChoiceAllowed("codex-foundry", "GPT-6.1-Sol", null, env)).toBe(true);
  expect(managedChoiceAllowed(null, null, null, env)).toBe(true);
  for (const choice of [["openai", "GPT-6.1-Sol", null], [null, "GPT-6.1-Sol", null],
    ["codex-foundry", "hidden", null], ["codex-foundry", "GPT-6.1-Sol", "high"]] as const)
    expect(managedChoiceAllowed(...choice, env)).toBe(false);
});
it("blocks direct credential, OAuth, memory and voice mutations before effects", async () => {
  const app = new Hono(); const effect = vi.fn(() => new Response("effect"));
  mountManagedServiceGuards(app, async () => ({ userId: "owner" }));
  app.all("*", effect);
  for (const route of ["models/connect", "models/probeCatalog", "models/startOAuth", "models/setDefault",
    "models/setBackups", "memory/connectProvider", "memory/disconnectProvider", "memory/providerConfig", "voice/status", "voice/connect", "voice/providers"])
    expect((await app.request("https://test/rpc/" + route, { method: "POST" })).status).toBe(403);
  expect((await app.request("https://test/api/voice/transcribe", { method: "POST" })).status).toBe(403);
  for (const route of ["/rpc//models/connect", "/rpc/models/%63onnect", "/rpc/MODELS/connect",
    "/rpc/models%252fconnect", "/rpc/models", "/rpc/memory", "/rpc//voice/connect"])
    expect((await app.request("https://test" + route, { method: "POST" })).status).toBeGreaterThanOrEqual(400);
  expect(effect).not.toHaveBeenCalled();
  expect((await app.request("https://test/rpc/models/list")).status).toBe(200);
});
it("does not disclose managed settings to unauthenticated callers", async () => {
  const app = new Hono(); mountManagedServiceGuards(app, async () => null);
  expect((await app.request("https://test/rpc/models/connect", { method: "POST" })).status).toBe(401);
});
