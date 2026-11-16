import { z } from "zod";

export const CheckpointKind = z.enum([
  "manual",
  "auto_pre_solve",
  "auto_pre_rollback",
  "auto_turn_boundary",
]);
const botId = z.string().min(1).max(160);
export const CheckpointCreate = z
  .object({
    botId,
    label: z.string().trim().max(120).optional(),
    expectedGeneration: z.number().int().nonnegative(),
  })
  .strict();
export const CheckpointRollback = z
  .object({
    botId,
    checkpointId: z.string().min(1).max(160),
    expectedGeneration: z.number().int().nonnegative(),
  })
  .strict();
export type CheckpointListItem = {
  id: string;
  kind: z.infer<typeof CheckpointKind>;
  label: string | null;
  branchId: string;
  createdAt: string;
  parentCheckpointId: string | null;
  promptPreview: string | null;
  promptCreatedAt: string | null;
};
export type CheckpointStatus = {
  generation: number;
  blocked: boolean;
  revision: string;
};
export type CheckpointView = CheckpointStatus & {
  activeBranchId: string | null;
  checkpoints: CheckpointListItem[];
  currentCheckpointId: string | null;
  branches: Array<{ id: string; parentCheckpointId: string | null; lastUsedAt: string }>;
};
