// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ bots: vi.fn() }));
vi.mock("../lib/rpc", () => ({ withSpaceHeaders: (value: unknown) => value, rpc: { bots: { list: mocks.bots } } }));
import { RulePrioritiesPanel, priorityApi } from "./RulePrioritiesPanel";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined; let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });
const catalog = { status: "current", policy: "workspace/agent-created/policy.rost", workingDirectory: "workspace/agent-created",
  sourceSha256: "a".repeat(64), cnl: "Current controlled language", maxWeight: "1000000000", tiers: ["critical", "high", "normal", "low"],
  rules: [{ id: "coverage", tier: "hard", weight: null, priority: "normal", sourceLine: 10, locked: true },
    { id: "agent_generated_fairness", summary: "Give each doctor a balanced number of duties.", tier: "soft", weight: "10", priority: "normal", sourceLine: 12, locked: false }] };
const review = { id: "e375d057-e532-4416-b617-3a6d2ab5a7c1", botId: "b", digest: "d".repeat(64), expiresAt: "2099-01-01T00:00:00Z",
  applied: null, review: { policy: catalog.policy, changes: [{ id: "agent_generated_fairness", weight: "20", priority: "normal" }],
    beforeRules: catalog.rules, beforeCnl: "before CNL", afterCnl: "after CNL", sourceDiff: "-weight=10\n+weight=20" } };
async function render(fetcher: typeof fetch) {
  mocks.bots.mockResolvedValue([{ id: "b", name: "Agent workspace" }]); vi.stubGlobal("fetch", vi.fn(fetcher));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<RulePrioritiesPanel />)); return container;
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
it("shows live agent-defined rules with locked hard rows and exact soft controls", async () => {
  await render(async () => Response.json(catalog));
  expect(container.textContent).toContain("workspace/agent-created/policy.rost");
  expect(container.querySelector('[aria-label="Weight for agent_generated_fairness"]')).not.toBeNull();
  expect(container.querySelectorAll('[aria-label="Priority for agent_generated_fairness"] option')).toHaveLength(4);
  await click("Hard"); expect(container.textContent).toContain("coverage"); expect(container.textContent).toContain("Locked");
  expect(container.querySelector('[aria-label="Weight for coverage"]')).toBeNull(); expect(container.querySelector('[type="checkbox"]')).toBeNull();
});
it("presents source/CNL review before any write and requires explicit draft confirmation", async () => {
  window.history.replaceState({}, "", "/app/b?priorityReview=" + review.id);
  await render(async () => Response.json(review));
  expect(container.textContent).toContain("before CNL"); expect(container.textContent).toContain("after CNL");
  expect(container.textContent).toContain("+weight=20"); expect(container.textContent).toContain("keep the original policy and active solves unchanged");
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((row) => row.textContent === "Create Reviewed Draft")!;
  expect(button.disabled).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
});
it("shows unregistered and stale failures without inventing policy rows", async () => {
  await render(async () => Response.json({ status: "not_registered" }));
  expect(container.textContent).toContain("No policy registered"); expect(container.querySelector("table")).toBeNull();
});
it("rejects HTML/proxy errors without showing raw responses", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private proxy failure", { status: 502 })));
  await expect(priorityApi("current?botId=b")).rejects.toThrow("unavailable");
});
it("shows business groups and controlled language in a bot-scoped chat panel", async () => {
  mocks.bots.mockResolvedValue([{ id: "b", name: "Agent workspace" }]);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...catalog, groups: [
    { id: "duties", label: "Duty fairness", description: "Balanced workload preferences.", ruleIds: ["agent_generated_fairness"] }],
    rules: catalog.rules.map((row) => ({ ...row, groupId: "duties" })) })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<RulePrioritiesPanel activeBotId="b" />));
  expect(container.querySelector('[aria-label="Policy bot"]')).toBeNull();
  expect(container.textContent).toContain("Duty fairness"); expect(container.querySelector("table")).toBeNull();
  const open = [...container.querySelectorAll("button")].find((row) => row.textContent?.includes("Duty fairness"))!;
  await act(async () => open.click());
  expect(container.textContent).toContain("Give each doctor a balanced number of duties.");
  expect(container.querySelector("details summary")?.textContent).not.toBe("agent_generated_fairness");
  expect(container.querySelector('[aria-label="Weight for agent_generated_fairness"]')).not.toBeNull();
});
