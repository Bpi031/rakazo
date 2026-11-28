import { z } from "zod";

const record = z.object({ id: z.string(), kind: z.string(), status: z.string() });

export const workbenchView = z.object({
  goal: z.object({ objective: z.string(), status: z.string(), revision: z.number().int() }),
  selectedSkill: z.object({ id: z.string().optional() }).nullish(),
  records: z.array(record.extend({ title: z.string() })),
  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      sha256: z.string().optional(),
    }),
  ),
  hooks: z.array(z.object({ name: z.string(), version: z.number(), description: z.string() })),
});

const detail = record.extend({ digest: z.string() });
export const workbenchDetail = z.discriminatedUnion("kind", [
  detail.extend({
    kind: z.literal("change"),
    payload: z.object({
      path: z.string(),
      before: z.string(),
      proposedText: z.string(),
      sourceSha256: z.string(),
    }),
  }),
  detail.extend({
    kind: z.literal("scenario"),
    payload: z.object({
      title: z.string(),
      sourceDigest: z.string(),
      messages: z.array(
        z.object({
          nonce: z.string(),
          question: z.string(),
          answer: z.string(),
          needsApproval: z.boolean(),
        }),
      ),
    }),
  }),
  detail.extend({ kind: z.literal("goal_proposal"), payload: z.object({ objective: z.string() }) }),
  detail.extend({
    kind: z.enum(["draft_receipt", "helper", "hook"]),
    payload: z.record(z.string(), z.json()),
  }),
]);

export type WorkbenchView = z.infer<typeof workbenchView>;
export type WorkbenchDetail = z.infer<typeof workbenchDetail>;
