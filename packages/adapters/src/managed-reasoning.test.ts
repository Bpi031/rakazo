import { expect, it } from "vitest";
import { managedEffort, managedReasoning } from "./managed-reasoning.mjs";

const env = {
  CODEX_DEPLOYMENTS: "flash,sol",
  CODEX_MODEL_REASONING: JSON.stringify({
    flash: { levels: ["low", "high", "max"], default: "high" },
    sol: { levels: ["low", "medium", "high", "xhigh", "max", "ultra"], default: "medium" },
  }),
};
it("keeps model-specific efforts and defaults, with no invented fallback", () => {
  const config = managedReasoning(env);
  expect(managedEffort("flash", null, config)).toBe("high");
  expect(managedEffort("sol", "ultra", config)).toBe("ultra");
  expect(() => managedEffort("flash", "medium", config)).toThrow();
  expect(() => managedEffort("flash", "ultra", config)).toThrow();
  expect(managedEffort("unknown", null, config)).toBeNull();
  expect(() => managedEffort("unknown", "high", config)).toThrow();
  expect(managedReasoning({ CODEX_DEPLOYMENTS: "flash" })).toEqual({});
});
it.each([
  null,
  [],
  { hidden: { levels: ["high"], default: "high" } },
  { flash: { levels: [], default: "high" } },
  { flash: { levels: ["high", "high"], default: "high" } },
  { flash: { levels: ["invented"], default: "invented" } },
  { flash: { levels: ["high"], default: "low" } },
  { flash: { levels: ["high"], default: "high", key: "forbidden" } },
])("rejects malformed operator efforts %j", (value) => {
  expect(() =>
    managedReasoning({ ...env, CODEX_MODEL_REASONING: JSON.stringify(value) }),
  ).toThrow();
});
