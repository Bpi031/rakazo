import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { workflowText } from "./workflow-text.js";
const root = mkdtempSync(path.join(tmpdir(), "workflow-key-"));
const key = path.join(root, "test-key");
writeFileSync(key, "x".repeat(48), { mode: 0o600 });
afterEach(() => vi.unstubAllEnvs());
import { afterAll } from "vitest";
afterAll(() => rmSync(root, { recursive: true }));
const input = {
  userId: "u",
  spaceId: "s",
  botId: "b",
  runId: "r",
  modelId: "approved",
  instruction: "Summarize",
  message: "Only explicitly shared text",
  maxOutputTokens: 512,
};
function setup(value: unknown = { text: "Summary", needsApproval: false }, extra = {}) {
  vi.stubEnv("CODEX_DEPLOYMENTS", "approved");
  vi.stubEnv("CODEX_INFERENCE_BASE_URL", "http://rost-inference:8080/v1");
  vi.stubEnv("CODEX_CAPABILITY_KEY_FILE", key);
  return vi.fn(async () =>
    Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        },
      ],
      ...extra,
    }),
  );
}
it("sends only explicit input through the scoped route with no tools or personal history", async () => {
  const fetcher = setup();
  expect((await workflowText(input, fetcher as any)).text).toBe("Summary");
  const [url, options] = (fetcher.mock.calls as any)[0];
  expect(url).toBe("http://rost-inference:8080/v1/responses");
  const body = JSON.parse(options.body);
  expect(body.tools).toEqual([]);
  expect(body.stream).toBe(false);
  expect(body.max_output_tokens).toBe(512);
  expect(body.input).toEqual([{ role: "user", content: input.message }]);
  expect(options.redirect).toBe("error");
  const scope = JSON.parse(
    Buffer.from(options.headers.authorization.slice(7).split(".")[0], "base64url").toString(),
  );
  expect(scope).toMatchObject({ user: "u", space: "s", bot: "b", run: "r", model: "approved" });
});
it.each([
  { text: "Needs a solve", needsApproval: true },
  { text: "No action executed", needsApproval: false },
])("returns bounded results without executing requested actions", async (value) => {
  const fetcher = setup(value);
  expect(await workflowText(input, fetcher as any)).toMatchObject(value);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { text: "x".repeat(8001), needsApproval: false },
  { text: "", needsApproval: false },
  { text: "x", needsApproval: "yes" },
  { text: "x\u0000", needsApproval: false },
  { text: "x\ud800", needsApproval: false },
  { text: "x", needsApproval: false, execute: "shell" },
])("rejects malformed output %j", async (value) => {
  const fetcher = setup(value);
  await expect(workflowText(input, fetcher as any)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects tool calls and incomplete results", async () => {
  for (const extra of [
    { status: "incomplete" },
    { output: [{ type: "function_call", name: "shell" }] },
  ])
    await expect(workflowText(input, setup(undefined, extra) as any)).rejects.toThrow();
});
it("never retries or falls back after a network or provider failure", async () => {
  setup();
  const fetcher = vi.fn(async () => new Response("failure", { status: 429 }));
  await expect(workflowText(input, fetcher)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(workflowText({ ...input, modelId: "other" }, fetcher)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
