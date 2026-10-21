// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentReportBlock } from "@rakazo/contracts";
import { AgentReportCard, orderedReportRows, reportRequest } from "./AgentReportCard";
import type { Root } from "react-dom/client";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); });
const block = AgentReportBlock.parse({ kind: "agent_report", report: { schema: "rakazo/agent-report/v1", title: "Example review",
  sourcePaths: ["workspace/source.json"], sections: [{ kind: "metrics", items: [{ label: "Unknown", value: null }] },
    { kind: "table", title: "Calls", columns: [{ key: "name", label: "Doctor", type: "text" }, { key: "count", label: "Weekend calls", type: "number" }],
      rows: [{ name: "Example Ten", count: 10 }, { name: "Example Two", count: 2 }, { name: "Example Missing", count: null }], rowQuestion: "Explain this allocation." }],
  actions: [{ label: "Discuss preference", request: "Review the preference, do not change it." }] }, evidence: { reportPath: "workspace/report.json", reportSha256: "a".repeat(64),
    sources: [{ path: "workspace/source.json", sha256: "b".repeat(64), bytes: 1 }], publishedAt: new Date().toISOString(), authority: "agent_analysis" } });
async function render(onCompose = vi.fn()) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AgentReportCard block={block} onCompose={onCompose} />)); return onCompose;
}
it("renders useful widgets and source evidence with null distinct from zero", async () => {
  await render(); expect(host.textContent).toContain("Unavailable"); expect(host.textContent).toContain("Agent analysis");
  expect(host.textContent).toContain("workspace/source.json"); expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
});
it("contains table overflow inside the report rather than enlarging its chat bubble", async () => {
  await render();
  expect(host.querySelector('[data-agent-report]')?.className).toContain("[contain:inline-size]");
  expect(host.querySelector('[aria-label="Calls table"]')?.className).toContain("overflow-auto");
  expect(host.querySelector('[aria-label="Calls table"]')?.getAttribute("tabindex")).toBe("0");
  expect(host.querySelector('table')?.parentElement?.className).toContain("max-w-full");
});
it("sorts numerically, keeps null last in both directions and filters without mutating source", () => {
  const table = block.report.sections[1]; if (table?.kind !== "table") throw new Error("fixture");
  expect(orderedReportRows(table, "", "count").map((x) => x.row.count)).toEqual([2,10,null]);
  expect(orderedReportRows(table, "", "count", true).map((x) => x.row.count)).toEqual([10,2,null]);
  expect(orderedReportRows(table, "two")).toHaveLength(1); expect(table.rows[0]!.count).toBe(10);
});
it("prepares a source-bound editable request rather than a solve or approval", async () => {
  const onCompose = await render(); const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Discuss preference"))!;
  await act(async () => button.click()); expect(onCompose).toHaveBeenCalledTimes(1);
  expect(onCompose.mock.calls[0]![0]).toContain(block.evidence.reportSha256);
  expect(onCompose.mock.calls[0]![0]).toContain("not policy approval or additional solve allowance");
  expect(reportRequest(block, "why")).toContain("why");
});
it("renders untrusted labels as text, never executable HTML", async () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AgentReportCard block={{ ...block, report: { ...block.report, title: "<img src=x onerror=bad()>" } }} />));
  expect(host.querySelector("img")).toBeNull(); expect(host.textContent).toContain("<img src=x onerror=bad()>");
});
it("paginates without creating hundreds of DOM rows and shows empty search explicitly", async () => {
  const value = structuredClone(block); const table = value.report.sections[1];
  if (table?.kind !== "table") throw new Error("fixture");
  table.rows = Array.from({ length: 30 }, (_, i) => ({ name: `Example ${i}`, count: i }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AgentReportCard block={value} />));
  expect(host.querySelectorAll("tbody tr")).toHaveLength(25);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click());
  expect(host.querySelectorAll("tbody tr")).toHaveLength(5);
  expect(host.textContent).not.toContain("Ask about this row");
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "no match"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
  expect(host.textContent).toContain("No matching rows");
});
