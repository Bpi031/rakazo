import { z } from "zod";
import { safeText, WorkspacePath } from "./agent-workbench.js";

export const NativePreferences = z.object({
  mode: z.enum(["plan", "execute"]),
  persistence: z.boolean(),
  action: z.enum(["none", "compact", "review", "fork"]).default("none"),
}).strict();
export const NativeDecision = z.object({
  operation: z.literal("native_settings"),
  botId: z.string().min(1).max(160),
  revision: z.number().int().nonnegative(),
  preferences: NativePreferences,
}).strict();
export const CompletionReceipt = z.object({
  schema: z.literal("rakazo/completion/v1"),
  kind: z.enum(["answer", "artifacts"]),
  outcome: z.enum(["complete", "blocked", "needs_review"]),
  message: safeText(12000).pipe(z.string().min(1)),
  deliverables: z.array(z.object({ path: WorkspacePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(12),
  evidence: z.array(z.object({ kind: z.enum(["validation", "readback", "diagnosis"]), path: WorkspacePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(12),
}).strict().refine((v) => v.kind !== "artifacts" || v.outcome !== "complete" || v.deliverables.length > 0, "Artifact completion needs deliverables");
export const completionSchema = z.toJSONSchema(CompletionReceipt);
export const nativeReadTools = [
  { name: "workspace_read", description: "Read a bounded UTF-8 file in this private workspace. No secrets, hidden paths or symlinks.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "workspace_list", description: "List bounded private workspace file metadata. No file contents, secrets or hidden paths.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];
