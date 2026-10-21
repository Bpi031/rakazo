import { z } from "zod";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const leadershipProposal = z
  .object({ successorBotId: id, workflowIds: z.array(id).max(20) })
  .strict();
export const leadershipDecision = z
  .object({
    id,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    operation: z.enum(["offer", "accept", "decline", "cancel"]),
    password: z.string().min(1).max(1024),
  })
  .strict();
export const leadershipToolInput = z
  .object({ operation: z.enum(["propose", "list"]), proposal: leadershipProposal.optional() })
  .strict();
export const leadershipTools = [
  {
    name: "team_leadership",
    description:
      "Propose a manager/lead-bot handover from this manager's bot to an active teammate's own bot. Human sender confirmation and successor acceptance are mandatory in chat. Non-owner managers become members; deployment/organization owners remain owners. Existing private bot histories, files, workspaces, credentials, licenses and active solves are NEVER moved. Selected workflow definitions are copied as new drafts needing fresh recipient consent; old workflows are paused, not deleted. Use list for current receipts. Agents cannot offer, accept or apply handovers.",
    inputSchema: z.toJSONSchema(leadershipToolInput, { io: "input" }),
  },
];
