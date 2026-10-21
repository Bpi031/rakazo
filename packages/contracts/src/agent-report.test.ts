import { expect, it } from "vitest";
import { AgentReportDefinition, AgentReportBlock, ReportWorkspacePath } from "./agent-report.js";
import { MessageBlock } from "./events.js";
export const example = () => ({ schema: "rakazo/agent-report/v1", title: "Distribution",
  sourcePaths: ["workspace/run/solution.json"], sections: [{ kind: "table", title: "Calls",
    columns: [{ key: "doctor", label: "Doctor", type: "text" }, { key: "count", label: "Calls", type: "number" }],
    rows: [{ doctor: "Example", count: 2 }, { doctor: "Other", count: null }] }] });
it("accepts bounded plain-data reports and persists their explicit analysis authority", () => {
  const report = AgentReportDefinition.parse(example());
  const block = { kind: "agent_report", report, evidence: { reportPath: "workspace/report.json", reportSha256: "a".repeat(64),
    publishedAt: new Date().toISOString(), sources: [{ path: report.sourcePaths[0], sha256: "b".repeat(64), bytes: 5 }], authority: "agent_analysis" } };
  expect(MessageBlock.parse(JSON.parse(JSON.stringify(block)))).toEqual(block);
  expect(AgentReportBlock.safeParse({ ...block, evidence: { ...block.evidence, authority: "validated" } }).success).toBe(false);
  expect(AgentReportBlock.safeParse({ ...block, evidence: { ...block.evidence, sources: [] } }).success).toBe(false);
});
it.each(["../secret", "workspace/../key", "/workspace/report.json", "workspace//report.json", "workspace/./report.json", "workspace/x\u0000"])('rejects unsafe path %j', (path) => {
  expect(ReportWorkspacePath.safeParse(path).success).toBe(false);
});
it("rejects wrong cell types, unknown columns, duplicate columns and unsafe numbers", () => {
  for (const rows of [[{ doctor: "x", count: "2" }], [{ doctor: "x", count: NaN }], [{ doctor: "x", count: Infinity }],
    [{ doctor: "x", count: 2 ** 53 }], [{ doctor: "x", count: 1, approval: true }], [{ count: 1 }]]) {
    const value = example(); value.sections[0]!.rows = rows as any;
    expect(AgentReportDefinition.safeParse(value).success).toBe(false);
  }
  const value = example(); value.sections[0]!.columns.push(value.sections[0]!.columns[0]!);
  expect(AgentReportDefinition.safeParse(value).success).toBe(false);
});
it("refuses executable widgets, approval claims, unbounded rows and duplicate sources", () => {
  expect(AgentReportDefinition.safeParse({ ...example(), approved: true }).success).toBe(false);
  expect(AgentReportDefinition.safeParse({ ...example(), sections: [{ kind: "html", html: "<script>bad()</script>" }] }).success).toBe(false);
  const value = example(); value.sections[0]!.rows = Array.from({ length: 501 }, () => ({ doctor: "x", count: 1 }));
  expect(AgentReportDefinition.safeParse(value).success).toBe(false);
  expect(AgentReportDefinition.safeParse({ ...example(), sourcePaths: ["workspace/x", "workspace/x"] }).success).toBe(false);
});
