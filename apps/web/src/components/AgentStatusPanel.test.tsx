// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AgentStatusPanel } from "./AgentStatusPanel";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("renders exact reported steps, unknown counters and safe text without actions", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const value = {
    plan: [{ step: "<img src=x onerror=bad()>", status: "inProgress" as const }],
    activity: { kind: "command" as const, status: "completed" as const, durationMs: 100 },
    usage: {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      reasoningTokens: null,
      totalTokens: 110,
      contextWindow: null,
    },
  };
  await act(async () => root.render(<AgentStatusPanel value={value} live />));
  expect(host.querySelector("details")?.open).toBe(true);
  expect(host.textContent).toContain("0/1 steps");
  expect(host.textContent).toContain("110 tokens");
  expect(host.querySelector('[aria-label="Token counter scope"]')?.textContent).toContain("Session total (legacy record)");
  expect(host.textContent).toContain("Unavailable");
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("button")).toBeNull();
  await act(async () => root.render(<AgentStatusPanel value={value} live={false} />));
  expect(host.querySelector("details")?.open).toBe(false);
  expect(host.textContent).toContain("unfinished");
  await act(async () => root.render(<AgentStatusPanel value={{...value, usage: {...value.usage, scope: "turn"}}} live={false} />));
  expect(host.querySelector('[aria-label="Token counter scope"]')?.textContent).toBe("This turn");
  await act(async () => root.unmount());
  host.remove();
});
