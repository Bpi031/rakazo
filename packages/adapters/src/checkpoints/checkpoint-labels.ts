import type { CheckpointRenameInput } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

export function checkpointRevision(
  generation: number,
  blocked: boolean,
  workspaceKey: string,
  latest?: string,
  labelRevision = 0,
) {
  return `${generation}:${blocked}:${workspaceKey}:${latest ?? ""}${labelRevision ? `:${labelRevision}` : ""}`;
}

export async function advanceLabelRevision(tx: Prisma.TransactionClient, threadId: string) {
  const updated = await tx.thread.update({
    where: { id: threadId },
    data: { checkpointLabelRevision: { increment: 1 } },
    select: { checkpointLabelRevision: true },
  });
  return updated.checkpointLabelRevision;
}

export async function writeCheckpointLabel(
  tx: Prisma.TransactionClient,
  threadId: string,
  input: CheckpointRenameInput,
  checkpointScope: Prisma.CheckpointWhereInput,
) {
  const labelRevision = await advanceLabelRevision(tx, threadId);
  const updated =
    "branchId" in input
      ? await tx.conversationBranch.updateMany({
          where: { id: input.branchId, threadId },
          data: { label: input.label },
        })
      : await tx.checkpoint.updateMany({
          where: { ...checkpointScope, id: input.checkpointId },
          data: { customLabel: input.label, labelRevision },
        });
  if (updated.count !== 1) throw new IsolationError();
}

type DisplayLabel = { label: string; revision: number; renamed: boolean };

export function latestCheckpointLabel(
  row: { customLabel?: string | null; label: string | null; labelRevision?: number },
  prior?: DisplayLabel,
): DisplayLabel | undefined {
  const label = row.customLabel ?? row.label;
  if (!label?.trim()) return prior;
  const revision = row.labelRevision ?? 0;
  const renamed = row.customLabel != null;
  if (
    !prior ||
    revision > prior.revision ||
    (revision === prior.revision && (renamed || !prior.renamed))
  )
    return { label, revision, renamed };
  return prior;
}
