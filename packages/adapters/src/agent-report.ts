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
Use schema rakazo/agent-report/v1. Required: title, sourcePaths (1-8 actual workspace/... files), sections.
Uploaded attachments/... paths are not report sources. For your owned upload, preserve the original, make an unchanged copy under workspace/inputs, verify matching SHA-256, and cite that copy. Never widen access, modify validated data or rerun a solve to repair presentation.
Sections: {kind:"text",title,text}; {kind:"metrics",items:[{label,value,unit?}]};
{kind:"table",title,columns:[{key,label,type:"text"|"number"}],rows:[{key:value}],rowQuestion?}.
Cells are string, finite safe number, or null (unavailable), never formulas or HTML. Exact column keys/types required.
Optional summary and actions:[{label,request}]. Action clicks only prepare an editable chat draft, never authorize a change or solve.
Limits: 256 KiB JSON, 8 sections, 16 columns/500 rows per table, 8000 total cells, 4 actions.
sourcePaths are hashed at publication, not proof that Python used them correctly. The report is agent analysis, not validation or approval.
Use shell/Python to calculate from exact source/solution files. Preserve rank versus weight, scope and unknowns. Never label illustrative numbers as measured.
For charts call render_plot (help:true first), for decisions ask_user and wait, and attach_file for verified downloads.
Choose only useful widgets, not every widget. Normal prose is best for short answers. No live model or additional solve is needed to publish an analysis.
A rejected report is not published. Correct its input or explain the limitation in prose; it must not prevent attaching independently validated and read-back-verified requested files.
Example: {"schema":"rakazo/agent-report/v1","title":"Weekend distribution","sourcePaths":["workspace/run/solution.json"],"sections":[{"kind":"table","title":"Calls","columns":[{"key":"doctor","label":"Doctor","type":"text"},{"key":"weekends","label":"Weekend calls","type":"number"}],"rows":[{"doctor":"Example only","weekends":null}],"rowQuestion":"Explain this allocation using the cited source."}],"actions":[{"label":"Discuss preferences","request":"Help me review the weekend preferences. Do not change policy yet."}]}`;
export const reportTools = [{ name: "present_report", description: "Publish an inline interactive report in this chat from your Python-generated JSON: summary metrics, searchable/sortable tables, expandable detail and editable follow-up requests. Choose presentation suited to the user's task, not just rostering. Does not execute report code, change policy, grant approval or start solves. Use help:true for the exact schema and limits.",
  inputSchema: { type: "object", properties: { help: { type: "boolean" }, report_path: { type: "string" } }, additionalProperties: false } }];

const readFailure = z.object({ code: z.enum([
  "ROST_REPORT_SOURCE_PATH", "ROST_REPORT_SOURCE_READ", "ROST_REPORT_READ_REJECTED",
]), sourceIndex: z.number().int().min(0).max(7).optional() }).strict();

function rejectReport(code: string, sourceIndex?: number): {
  block?: never; code: string; error: string; sourceIndex?: number;
  reportPublished: false; solveStarted: false; action: string;
} {
  return { code, error: "Report was not published; correct its bounded input before publishing.",
    ...(sourceIndex === undefined ? {} : { sourceIndex }), reportPublished: false, solveStarted: false,
    action: code === "ROST_REPORT_SOURCE_PATH"
      ? "sourcePaths must cite workspace/... files. For an owned uploaded attachment, preserve the original, copy its unchanged bytes into the private workspace/inputs, verify matching SHA-256 and cite that copy. Never widen access or rerun numerical work."
      : "Read present_report help:true, inspect the owned report and cited files locally, and correct paths, JSON, schema or finite sizes. No report was published. Keep all source-access guards. Do not restart a solve or change validated data; verified requested downloads can still be attached without this optional report." };
}

export async function readAgentReport(sandbox: SandboxProvider, computer: ComputerRef, context: AdapterContext,
  input: unknown, redact: (text: string) => string = (s) => s) {
  const parsed = reportInput.safeParse(input);
  if (!parsed.success) return rejectReport("ROST_REPORT_ARGUMENTS");
  const args = parsed.data;
  if (args.help === true) return { guide: REPORT_GUIDE };
  let stdout = ""; let code: number | undefined;
  for await (const event of sandbox.execute(computer, {
    argv: ["/opt/office-python/bin/python3", "-I", "-c", reader, Buffer.from(args.report_path).toString("base64")],
    cwd: "/home/rakazo", timeoutMs: 15_000, unsetEnv: ["PYTHONPATH", "PYTHONHOME", "LD_PRELOAD"],
  }, context)) {
    if (event.type === "stdout") { stdout += event.data; if (Buffer.byteLength(stdout) > 400_000) throw new Error("Report output cap exceeded"); }
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0) {
    if (code === 1) {
      let value: unknown;
      try { value = JSON.parse(stdout); } catch { /* Unknown process failures remain fatal. */ }
      const rejected = readFailure.safeParse(value);
      if (rejected.success) return rejectReport(rejected.data.code, rejected.data.sourceIndex);
    }
    throw new Error("Report publication failed; inspect its sources and finite limits");
  }
  // Redaction never alters the on-disk evidence or grants numerical authority.
  const value = JSON.parse(redact(stdout));
  const checked = AgentReportBlock.safeParse({ kind: "agent_report", report: value.report, evidence: {
    reportPath: args.report_path, reportSha256: value.reportSha256, sources: value.sources,
    publishedAt: new Date().toISOString(), authority: "agent_analysis",
  } });
  if (!checked.success) return rejectReport("ROST_REPORT_SCHEMA");
  const block = checked.data;
  if (Buffer.byteLength(JSON.stringify(block)) > 300_000) return rejectReport("ROST_REPORT_MESSAGE_CAP");
  return { block };
}
