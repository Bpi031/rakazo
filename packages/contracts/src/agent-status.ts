import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const AgentStatusFields = z
  .object({
    configuration: z.object({ model: z.string().min(1).max(128), effort: z.string().min(1).max(16) }).strict().optional(),
    plan: z
      .array(
        z
          .object({
            step: z.string().min(1).max(1000),
            status: z.enum(["pending", "inProgress", "completed"]),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    explanation: z.string().max(1000).optional(),
    usage: z
      .object({
        scope: z.enum(["turn", "session"]).optional(),
        inputTokens: count,
        outputTokens: count,
        cachedInputTokens: count,
        reasoningTokens: count,
        totalTokens: count,
        contextWindow: count,
        contextUsedTokens: count.optional(),
      })
      .strict()
      .optional(),
    activity: z
      .object({
        kind: z.enum(["command", "file_change", "tool", "web_search", "compaction"]),
        status: z.enum(["running", "completed", "failed", "declined"]),
        durationMs: count.optional(),
        filesChanged: count.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentStatusFields = z.infer<typeof AgentStatusFields>;
export const AgentStatusBlock = AgentStatusFields.extend({ kind: z.literal("agent_status") });
