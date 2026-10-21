import * as z from "zod";

const text = (max: number) => z.string().min(1).max(max).refine((s) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s));
export const ReportWorkspacePath = z.string().max(1024).refine((s) => s.startsWith("workspace/") &&
  !/[\\\x00-\x1f]/.test(s) && s.split("/").every((p) => p !== "" && p !== "." && p !== ".."));
const cell = z.union([text(512), z.literal(""), z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.null()]);
const column = z.object({ key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), label: text(80),
  type: z.enum(["text", "number"]) }).strict();
const table = z.object({ kind: z.literal("table"), title: text(120), columns: z.array(column).min(1).max(16),
  rows: z.array(z.record(z.string(), cell)).max(500), rowQuestion: text(800).optional() }).strict().superRefine((value, ctx) => {
  const keys = value.columns.map((c) => c.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate table column" });
  for (const row of value.rows) {
    if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) {
      ctx.addIssue({ code: "custom", message: "Rows must contain exactly the declared columns" }); break;
    }
    for (const c of value.columns) if (row[c.key] !== null && typeof row[c.key] !== (c.type === "number" ? "number" : "string")) {
      ctx.addIssue({ code: "custom", message: "Cell type does not match column" }); break;
    }
  }
});
export const AgentReportDefinition = z.object({
  schema: z.literal("rakazo/agent-report/v1"), title: text(160), summary: text(2000).optional(),
  sourcePaths: z.array(ReportWorkspacePath).min(1).max(8),
  sections: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), title: text(120), text: text(4000) }).strict(),
    z.object({ kind: z.literal("metrics"), items: z.array(z.object({ label: text(80), value: cell,
      unit: text(40).optional() }).strict()).min(1).max(8) }).strict(),
    table,
  ])).min(1).max(8),
  actions: z.array(z.object({ label: text(60), request: text(1200) }).strict()).max(4).optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.sourcePaths).size !== value.sourcePaths.length) ctx.addIssue({ code: "custom", message: "Duplicate source path" });
  const cells = value.sections.reduce((n, s) => n + (s.kind === "table" ? s.rows.length * s.columns.length : 0), 0);
  if (cells > 8000) ctx.addIssue({ code: "custom", message: "Report exceeds 8000 cells" });
});
export type AgentReport = z.infer<typeof AgentReportDefinition>;
export const AgentReportBlock = z.object({ kind: z.literal("agent_report"), report: AgentReportDefinition,
  evidence: z.object({ reportPath: ReportWorkspacePath, reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
    publishedAt: z.iso.datetime(), sources: z.array(z.object({ path: ReportWorkspacePath,
      sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }).strict()).min(1).max(8),
    authority: z.literal("agent_analysis"),
  }).strict(),
}).strict().superRefine((block, ctx) => {
  if (block.evidence.sources.length !== block.report.sourcePaths.length ||
      block.evidence.sources.some((source, i) => source.path !== block.report.sourcePaths[i])) {
    ctx.addIssue({ code: "custom", message: "Report sources do not match captured evidence" });
  }
});
export type AgentReportMessage = z.infer<typeof AgentReportBlock>;
