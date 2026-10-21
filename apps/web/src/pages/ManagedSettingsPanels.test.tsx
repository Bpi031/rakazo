// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), bots: vi.fn(), update: vi.fn() }));
vi.mock("../lib/rpc", () => ({ withSpaceHeaders: () => ({}), rpc: { models: { list: mocks.list }, bots: { list: mocks.bots, update: mocks.update } } }));
import { ManagedMemoryPanel, ManagedModelsPanel } from "./ManagedSettingsPanels";
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) { await act(async () => root.unmount()); container.remove(); }
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ resetsAt: 172800, models: [{ model: "DeepSeek-V4.1-Flash",
    calls: 2, outputReserved: 16384, knownUsageCalls: 1, inputTokens: 200, outputTokens: 25,
    limits: { calls: 1000, output_tokens: 8192000 } }] })));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  await act(async () => root.render(node));
  return container;
}
it("shows only provided models and saves an exact per-bot choice", async () => {
  mocks.list.mockResolvedValue([{ id: "DeepSeek-V4.1-Flash", label: "DeepSeek 4.1 Flash" }, { id: "GPT-6.1-Sol", label: "GPT 6.1 Sol" }]);
  mocks.bots.mockResolvedValue([{ id: "b", name: "Roster", modelId: null }]);
  mocks.update.mockResolvedValue({ id: "b", name: "Roster", modelId: "GPT-6.1-Sol" });
  const container = await render(<ManagedModelsPanel />);
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Model for Roster"]')!;
  expect(container.textContent).not.toContain("API key");
  expect(container.textContent).not.toContain("codex-foundry");
  await act(async () => { select.value = "GPT-6.1-Sol"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(mocks.update).toHaveBeenCalledWith({ botId: "b", modelProvider: "codex-foundry", modelId: "GPT-6.1-Sol", thinkingLevel: null });
  expect(container.textContent).toContain("Active roster jobs are unchanged");
  expect(container.textContent).toContain("1 of 2 calls reported");
  expect(container.textContent).toContain("Provider fallback: Disabled");
});
it("does not expose provider-key inputs in native memory", async () => {
  const container = await render(<ManagedMemoryPanel />);
  expect(container.textContent).toContain("MEMORY.md · Available");
  expect(container.querySelector("input")).toBeNull();
});
it("keeps errors actionable without raw backend details", async () => {
  mocks.list.mockRejectedValue(new Error("secret database path")); mocks.bots.mockResolvedValue([]);
  const container = await render(<ManagedModelsPanel />);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
  expect(container.textContent).not.toContain("secret database path");
});
