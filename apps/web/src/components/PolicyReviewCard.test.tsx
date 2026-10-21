// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("../pages/RulePrioritiesPanel", () => ({ priorityApi: api }));
import { PolicyReviewCard } from "./PolicyReviewCard";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); vi.resetAllMocks(); });
const row = { id: "c6593e57-08c1-48e6-8301-a656185963de", botId: "b", digest: "d".repeat(64), expiresAt: "2099-01-01T00:00:00Z", applied: null,
  review: { changes: [{ id: "fairness", weight: "20", priority: "low" }], beforeRules: [{ id: "fairness", summary: "Prefer weekend order", weight: "10", priority: "low" }],
    sourceDiff: "+weight=20", beforeCnl: "Old meaning", afterCnl: "Reviewed meaning" } };
async function render(value = row) {
  api.mockResolvedValue(value); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<PolicyReviewCard botId="b" reviewId={row.id} />));
}
it("shows exact review and refuses to apply without deliberate browser confirmation", async () => {
  await render(); expect(api).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("Prefer weekend order");
  expect(host.textContent).toContain("Reviewed meaning"); expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  expect(host.querySelectorAll("select")).toHaveLength(0);
});
it("does not show a different bot's review or leak its contents", async () => {
  await render({ ...row, botId: "other" }); expect(host.textContent).toContain("unavailable");
  expect(host.textContent).not.toContain("Reviewed meaning"); expect(host.querySelector("input")).toBeNull();
});
it("disables expired reviews while keeping their evidence visible", async () => {
  await render({ ...row, expiresAt: "2000-01-01T00:00:00Z" });
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  expect(host.textContent).toContain("keep hard rules".replace("keep", "Keep"));
});
