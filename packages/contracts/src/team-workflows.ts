import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const text = z.string().refine(
  (s) =>
    !s.includes("\u0000") &&
    !Array.from(s).some((c) => {
      const n = c.codePointAt(0)!;
      return n >= 0xd800 && n <= 0xdfff;
    }),
  "Use well-formed text without NUL",
);
export const workflowDefinitionSchema = z
  .object({
    name: text.and(z.string().trim().min(1).max(100)),
    leadBotId: id,
    objective: text.and(z.string().trim().min(1).max(2000)),
    modelId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    participants: z
      .array(
        z.object({ botId: id, instruction: text.and(z.string().trim().min(1).max(1000)) }).strict(),
      )
      .min(1)
      .max(8),
    allowParticipantStart: z.boolean(),
    maxStartsPerDay: z.number().int().min(1).max(20),
    maxOutputTokens: z.number().int().min(256).max(4096),
    grantDays: z.number().int().min(1).max(30),
  })
  .strict()
  .superRefine((value, ctx) => {
    const bots = [value.leadBotId, ...value.participants.map((p) => p.botId)];
    if (new Set(bots).size !== bots.length)
      ctx.addIssue({ code: "custom", message: "Use distinct lead and participant bots" });
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export const workflowToolInput = z
  .object({
    operation: z.enum(["directory", "list", "propose", "inspect", "start", "submit"]),
    definition: workflowDefinitionSchema.optional(),
    workflowId: id.optional(),
    message: text.and(z.string().trim().min(1).max(8000)).optional(),
  })
  .strict();
export const workflowDecisionSchema = z
  .object({
    id,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    operation: z.enum(["enable", "pause", "consent", "revoke"]),
    password: z.string().min(1).max(1024),
  })
  .strict();
export const workflowTools = [
  {
    name: "team_workflows",
    description:
      "Configure manager-led, message-only team workflows. Use directory for exact bot IDs, propose for a reviewable draft, list/inspect for state, start from the lead bot or submit from a consenting participant. Definitions need manager approval and each recipient owner's consent in chat. Automated steps receive only explicitly shared messages: no private files/history, shell, Rost, policy approval or external actions. Never describe an enabled workflow or completed task without its receipt. Return the reviewUrl so the user can review in chat.",
    inputSchema: z.toJSONSchema(workflowToolInput, { io: "input" }),
  },
];
