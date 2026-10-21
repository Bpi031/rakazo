import { readFileSync } from "node:fs";
import type { SandboxProvider, AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { AgentReportBlock, ReportWorkspacePath } from "@rakazo/contracts";
import { z } from "zod";

const reader = readFileSync(new URL("./agent-report-reader.py", import.meta.url), "utf8");
export const reportInput = z.union([
  z.object({ help: z.literal(true) }).strict(),
  z.object({ report_path: ReportWorkspacePath, help: z.literal(false).optional() }).strict(),
]);
export const REPORT_GUIDE = `Write a UTF-8 JSON file with Python in the bot workspace, then call present_report with report_path.
Use schema rakazo/agent-report/v1. Required: title, sourcePaths (1-8 actual workspace-relative files), sections.
Sections: {kind:"text",title,text}; {kind:"metrics",items:[{label,value,unit?}]};
{kind:"table",title,columns:[{key,label,type:"text"|"number"}],rows:[{key:value}],rowQuestion?}.
Cells are string, finite safe number, or null (unavailable), never formulas or HTML. Exact column keys/types required.
Optional summary and actions:[{label,request}]. Action clicks only prepare an editable chat draft, never authorize a change or solve.
Limits: 256 KiB JSON, 8 sections, 16 columns/500 rows per table, 8000 total cells, 4 actions.
sourcePaths are hashed at publication, not proof that Python used them correctly. The report is agent analysis, not validation or approval.
Use shell/Python to calculate from exact source/solution files. Preserve rank versus weight, scope and unknowns. Never label illustrative numbers as measured.
For charts call render_plot (help:true first), for decisions ask_user and wait, and attach_file for verified downloads.
Choose only useful widgets, not every widget. Normal prose is best for short answers. No live model or additional solve is needed to publish an analysis.
Example: {"schema":"rakazo/agent-report/v1","title":"Weekend distribution","sourcePaths":["workspace/run/solution.json"],"sections":[{"kind":"table","title":"Calls","columns":[{"key":"doctor","label":"Doctor","type":"text"},{"key":"weekends","label":"Weekend calls","type":"number"}],"rows":[{"doctor":"Example only","weekends":null}],"rowQuestion":"Explain this allocation using the cited source."}],"actions":[{"label":"Discuss preferences","request":"Help me review the weekend preferences. Do not change policy yet."}]}`;
export const reportTools = [{ name: "present_report", description: "Publish an inline interactive report in this chat from your Python-generated JSON: summary metrics, searchable/sortable tables, expandable detail and editable follow-up requests. Choose presentation suited to the user's task, not just rostering. Does not execute report code, change policy, grant approval or start solves. Use help:true for the exact schema and limits.",
  inputSchema: { type: "object", properties: { help: { type: "boolean" }, report_path: { type: "string" } }, additionalProperties: false } }];

export async function readAgentReport(sandbox: SandboxProvider, computer: ComputerRef, context: AdapterContext,
  input: unknown, redact: (text: string) => string = (s) => s) {
  const args = reportInput.parse(input);
  if (args.help === true) return { guide: REPORT_GUIDE };
  let stdout = ""; let code: number | undefined;
  for await (const event of sandbox.execute(computer, {
    argv: ["/opt/office-python/bin/python3", "-I", "-c", reader, Buffer.from(args.report_path).toString("base64")],
    cwd: "/home/rakazo", timeoutMs: 15_000, unsetEnv: ["PYTHONPATH", "PYTHONHOME", "LD_PRELOAD"],
  }, context)) {
    if (event.type === "stdout") { stdout += event.data; if (Buffer.byteLength(stdout) > 400_000) throw new Error("Report output cap exceeded"); }
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0) throw new Error("Report publication failed; inspect its sources and finite limits");
  // Redaction never alters the on-disk evidence or grants numerical authority.
  const value = JSON.parse(redact(stdout));
  const block = AgentReportBlock.parse({ kind: "agent_report", report: value.report, evidence: {
    reportPath: args.report_path, reportSha256: value.reportSha256, sources: value.sources,
    publishedAt: new Date().toISOString(), authority: "agent_analysis",
  } });
  if (JSON.stringify(block).length > 300_000) throw new Error("Report message cap exceeded");
  return { block };
}
