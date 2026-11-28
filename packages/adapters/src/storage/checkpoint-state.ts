import { readJsonColumn } from "@rakazo/db";
import { z } from "zod";

export const checkpointTranscript = z.array(z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  role: z.string(),
  blocks: z.array(z.json()),
  botId: z.string().nullish(),
  authorUserId: z.string().nullish(),
  runId: z.string().nullish(),
  clientNonce: z.string().nullish(),
  replyToMessageId: z.string().nullish(),
  replyQuote: z.string().nullish(),
  createdAt: z.iso.datetime({ offset: true }),
}));

export const checkpointBusiness = z.object({
  binding: z.unknown(),
  artifacts: z.array(z.object({
    id: z.string().min(1),
    hash: z.string().min(1).optional(),
    storageKey: z.string().optional(),
  })),
  transcript: checkpointTranscript,
  botInstructions: z.string(),
  parentCheckpointId: z.string().nullish(),
});

export type CheckpointBusiness = z.infer<typeof checkpointBusiness>;

export function checkpointBusinessOf(row: { id: string; businessState: unknown }): CheckpointBusiness {
  return readJsonColumn(checkpointBusiness, row.businessState, {
    table: "checkpoints", column: "businessState", id: row.id,
  }, "reject");
}

export function checkpointAuditSource(row: { id: string; details: unknown }): string | undefined {
  return readJsonColumn(z.object({ fromBranchId: z.string().nullish() }), row.details, {
    table: "rollback_audit_logs", column: "details", id: row.id,
  }, { fallback: {} }).fromBranchId ?? undefined;
}

const textBlock = z.object({ kind: z.literal("text"), text: z.string() });

export function checkpointPromptMetadata(business: CheckpointBusiness) {
  const prompt = business.transcript.findLast((message) => message.role === "user");
  const text = (prompt?.blocks ?? []).flatMap((block) => {
    const parsed = textBlock.safeParse(block);
    return parsed.success ? [parsed.data.text] : [];
  }).join(" ").replace(/\s+/g, " ").trim();
  const chars = [...text];
  return {
    promptPreview: chars.length ? chars.slice(0, 180).join("") + (chars.length > 180 ? "…" : "") : null,
    promptCreatedAt: prompt?.createdAt ?? null,
  };
}
