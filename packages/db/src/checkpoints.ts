import type { Prisma, PrismaClient } from "./client.js";

type CheckpointReader = Pick<PrismaClient, "thread" | "conversationBranch">;

export class CheckpointConflictError extends Error {
  constructor(message = "Workspace changed or is unavailable during checkpoint recovery") {
    super(message);
    this.name = "CheckpointConflictError";
  }
}

/** Shared by checkpoint operations and normal writes, always acquired before row locks. */
export async function checkpointThreadLock(tx: Prisma.TransactionClient, threadId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`checkpoint:${threadId}`}, 0))`;
}

export async function ensureCheckpointBranch(tx: Prisma.TransactionClient, threadId: string) {
  await checkpointThreadLock(tx, threadId);
  const thread = await tx.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { activeBranchId: true, checkpointGeneration: true, checkpointBlocked: true },
  });
  if (thread.activeBranchId) return { ...thread, activeBranchId: thread.activeBranchId };
  const branchId = `initial:${threadId}`;
  await tx.conversationBranch.upsert({
    where: { id: branchId },
    create: { id: branchId, threadId },
    update: {},
  });
  await tx.thread.update({ where: { id: threadId }, data: { activeBranchId: branchId } });
  // Covers rows created before the first checkpoint-enabled write on a newly created thread.
  await tx.message.updateMany({ where: { threadId, branchId: null }, data: { branchId } });
  await tx.event.updateMany({ where: { threadId, branchId: null }, data: { branchId } });
  await tx.run.updateMany({ where: { threadId, branchId: null }, data: { branchId } });
  return { ...thread, activeBranchId: branchId };
}

export async function assertCheckpointGeneration(
  db: Pick<PrismaClient, "thread">,
  threadId: string,
  generation: number,
) {
  const thread = await db.thread.findUnique({
    where: { id: threadId },
    select: { checkpointGeneration: true, checkpointBlocked: true },
  });
  if (!thread || thread.checkpointBlocked || thread.checkpointGeneration !== generation) {
    throw new CheckpointConflictError();
  }
}

/** New runs bind to the current branch while the thread row excludes recovery. */
export async function checkpointRunFields(tx: Prisma.TransactionClient, threadId: string) {
  const thread = await tx.thread.update({
    where: { id: threadId },
    // An empty Prisma update may become a SELECT. A real no-op UPDATE holds
    // the row lock until the surrounding transaction commits.
    data: { checkpointGeneration: { increment: 0 } },
    select: { activeBranchId: true, checkpointGeneration: true, checkpointBlocked: true },
  });
  if (thread.checkpointBlocked) throw new CheckpointConflictError();
  return { branchId: thread.activeBranchId, checkpointGeneration: thread.checkpointGeneration };
}

export interface CheckpointVisibleSegment {
  branchId: string | null;
  messageSeq: number | null;
  eventSeq: number | null;
}

/** Global sequence cutoffs compose through every ancestor; descendants never see siblings. */
export function resolveCheckpointSegments(
  branches: ReadonlyArray<{
    id: string;
    parentBranchId: string | null;
    parentCutoffMessageSeq: number | null;
    parentCutoffEventSeq: number | null;
  }>,
  activeBranchId: string | null,
): CheckpointVisibleSegment[] {
  if (!activeBranchId) return [{ branchId: null, messageSeq: null, eventSeq: null }];
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  const seen = new Set<string>();
  const segments: CheckpointVisibleSegment[] = [];
  let id: string | null = activeBranchId;
  let messageSeq: number | null = null;
  let eventSeq: number | null = null;
  while (id) {
    if (seen.has(id)) throw new CheckpointConflictError("Invalid checkpoint branch ancestry");
    seen.add(id);
    const branch = byId.get(id);
    if (!branch) throw new CheckpointConflictError("Checkpoint branch is missing");
    segments.push({ branchId: id, messageSeq, eventSeq });
    if (branch.parentBranchId) {
      if (branch.parentCutoffMessageSeq === null || branch.parentCutoffEventSeq === null) {
        throw new CheckpointConflictError("Checkpoint branch boundary is missing");
      }
      messageSeq = Math.min(messageSeq ?? Infinity, branch.parentCutoffMessageSeq);
      eventSeq = Math.min(eventSeq ?? Infinity, branch.parentCutoffEventSeq);
    }
    id = branch.parentBranchId;
  }
  return segments;
}

export async function checkpointVisibleSegments(
  db: CheckpointReader,
  threadId: string,
  branchId?: string,
) {
  const thread = await db.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { activeBranchId: true },
  });
  if (!thread.activeBranchId && !branchId) {
    return [{ branchId: null, messageSeq: null, eventSeq: null }];
  }
  const branches = await db.conversationBranch.findMany({ where: { threadId } });
  return resolveCheckpointSegments(branches, branchId ?? thread.activeBranchId);
}

export async function checkpointMessageWhere(
  db: CheckpointReader,
  threadId: string,
): Promise<Prisma.MessageWhereInput> {
  const segments = await checkpointVisibleSegments(db, threadId);
  if (segments.length === 1 && segments[0]!.branchId === null) return { threadId };
  return {
    threadId,
    OR: segments.map((segment) => ({
      branchId: segment.branchId,
      ...(segment.messageSeq === null ? {} : { seq: { lte: segment.messageSeq } }),
    })),
  };
}

export async function checkpointEventWhere(
  db: CheckpointReader,
  threadId: string,
): Promise<Prisma.EventWhereInput> {
  const segments = await checkpointVisibleSegments(db, threadId);
  if (segments.length === 1 && segments[0]!.branchId === null) return { threadId };
  return {
    threadId,
    OR: segments.map((segment) => ({
      branchId: segment.branchId,
      ...(segment.eventSeq === null ? {} : { seq: { lte: segment.eventSeq } }),
    })),
  };
}
