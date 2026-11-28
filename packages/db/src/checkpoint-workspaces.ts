import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { CheckpointConflictError } from "./checkpoints.js";
import type { PrismaClient } from "./database/client.js";
import { Prisma } from "./database/client.js";

export interface CheckpointWorkspaceClaim {
  computerId: string;
  spaceId: string;
  userId: string;
  botId: string;
  owner: string;
  allowedRunId?: string;
  restore?: boolean;
  retry?: { threadId: string; expectedGeneration: number };
  // Only a caller holding withCheckpointRestoreLock can resume a journaled restore.
  restoreJournal?: {
    checkpointId: string;
    branchId: string;
    assertConfirmed?: (tx: Prisma.TransactionClient) => Promise<void>;
  };
}

const localRestores = new WeakSet<PrismaClient>();

/** PostgreSQL releases this operation lock when the owning API session exits. */
export async function withCheckpointRestoreLock<T>(
  prisma: PrismaClient,
  computerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  // Reserve only one long-lived connection per API pool; phase transactions need another.
  if (localRestores.has(prisma))
    throw new CheckpointConflictError("Another restore is still running");
  localRestores.add(prisma);
  try {
    return await prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`checkpoint-restore:${computerId}`}, 0)) AS acquired
    `;
        if (lock?.acquired !== true)
          throw new CheckpointConflictError("Another restore is still running");
        return operation();
      },
      { maxWait: 10_000, timeout: 1_200_000 },
    );
  } finally {
    localRestores.delete(prisma);
  }
}

export async function assertCheckpointRestoreOwner(
  tx: Prisma.TransactionClient,
  computerId: string,
  owner: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM computers WHERE id = ${computerId} AND "maintenanceId" = ${owner} FOR UPDATE
  `;
  if (rows.length !== 1) throw new CheckpointConflictError("Recovery was superseded", "stale");
}

/** A committed Computer maintenance owner spans all transactions of a restore. */
export async function claimCheckpointWorkspace(
  prisma: PrismaClient,
  input: CheckpointWorkspaceClaim,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM computers WHERE id = ${input.computerId} FOR UPDATE SKIP LOCKED
    `;
    if (locked.length !== 1)
      throw new CheckpointConflictError("Another operation is using this workspace");
    const computer = await tx.computer.findUniqueOrThrow({ where: { id: input.computerId } });
    const bot = await tx.bot.findFirst({
      where: {
        id: input.botId,
        userId: input.userId,
        spaceId: input.spaceId,
        computerId: input.computerId,
        archivedAt: null,
        computerSwitching: false,
      },
      select: { id: true },
    });
    if (
      !bot ||
      !["dedicated", "team"].includes(computer.scope) ||
      computer.userId !== input.userId ||
      computer.spaceId !== input.spaceId ||
      computer.state !== "running" ||
      !computer.providerRef
    )
      throw new CheckpointConflictError("Workspace is unavailable or undergoing maintenance");

    // Compare the confirmed history before replacing the maintenance owner or creating a journal.
    if (input.restore) await input.restoreJournal?.assertConfirmed?.(tx);

    if (computer.maintenanceId) {
      // Every attempt owns a unique token. An old failed attempt may be replaced,
      // but an in-progress attempt (including the same token) never re-enters.
      if (!input.restore || !input.retry || computer.maintenanceId === input.owner)
        throw new CheckpointConflictError("Workspace is undergoing checkpoint maintenance");
      const thread = await tx.thread.findFirst({
        where: {
          id: input.retry.threadId,
          botId: input.botId,
          spaceId: input.spaceId,
          userId: input.userId,
          checkpointGeneration: input.retry.expectedGeneration,
        },
        select: { id: true, checkpointBlocked: true },
      });
      const failed = thread?.checkpointBlocked
        ? await tx.rollbackAuditLog.findFirst({
            where: {
              threadId: thread.id,
              botId: input.botId,
              spaceId: input.spaceId,
              userId: input.userId,
              generation: input.retry.expectedGeneration,
              status: "failed",
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { details: true },
          })
        : null;
      const details = failed?.details;
      const matches = (value: Prisma.JsonValue | undefined) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.workspaceMaintenanceOwner === computer.maintenanceId &&
        value.workspaceComputerId === input.computerId;
      const journal =
        !matches(details) &&
        input.restoreJournal &&
        thread &&
        computer.maintenanceId.startsWith("checkpoint-restore:")
          ? await tx.rollbackAuditLog.findMany({
              where: {
                threadId: thread.id,
                botId: input.botId,
                spaceId: input.spaceId,
                userId: input.userId,
                generation: {
                  in: [input.retry.expectedGeneration, input.retry.expectedGeneration - 1],
                },
                status: "claimed",
              },
              select: { details: true },
            })
          : [];
      if (!matches(details) && !journal.some((row) => matches(row.details)))
        throw new CheckpointConflictError("Workspace recovery has not completed or failed yet");
    }

    // Managed Computers must belong exclusively to this account and Space.
    if (
      await tx.bot.count({
        where: {
          computerId: input.computerId,
          OR: [{ userId: { not: input.userId } }, { spaceId: { not: input.spaceId } }],
        },
      })
    )
      throw new CheckpointConflictError("Workspace ownership does not match");

    const now = new Date();
    if (
      computer.controlHolder === "user" ||
      (computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt > now &&
        computer.controlHolder !== "none" &&
        !(
          computer.controlHolder === "bot" &&
          computer.controlBotId === input.botId &&
          (input.restore ||
            (input.allowedRunId &&
              (await tx.computerExecutionLease.findFirst({
                where: {
                  computerId: input.computerId,
                  botId: input.botId,
                  runId: input.allowedRunId,
                  expiresAt: { gt: now },
                },
                select: { id: true },
              }))))
        ))
    )
      throw new CheckpointConflictError("Release workspace control before checkpointing");

    const writers = {
      bot: { computerId: input.computerId },
      ...(input.restore
        ? { botId: { not: input.botId } }
        : input.allowedRunId
          ? { id: { not: input.allowedRunId } }
          : {}),
      status: { in: [...ACTIVE_RUN_STATUSES] },
    };
    if (await tx.run.count({ where: writers }))
      throw new CheckpointConflictError("Another task is using this workspace");
    if (
      await tx.routine.count({
        where: {
          bot: { computerId: input.computerId },
          ...(input.restore ? { botId: { not: input.botId } } : {}),
          active: true,
          jobWatch: { not: Prisma.JsonNull },
        },
      })
    )
      throw new CheckpointConflictError("Stop watched jobs before checkpointing this workspace");

    await tx.computer.update({
      where: { id: input.computerId },
      data: { maintenanceId: input.owner },
    });
    if (input.restore && input.retry && input.restoreJournal) {
      await tx.rollbackAuditLog.create({
        data: {
          threadId: input.retry.threadId,
          botId: input.botId,
          spaceId: input.spaceId,
          userId: input.userId,
          toCheckpointId: input.restoreJournal.checkpointId,
          branchId: input.restoreJournal.branchId,
          generation: input.retry.expectedGeneration,
          status: "claimed",
          details: {
            workspaceMaintenanceOwner: input.owner,
            workspaceComputerId: input.computerId,
          },
        },
      });
    }
  });
}

export async function releaseCheckpointWorkspace(
  prisma: PrismaClient,
  computerId: string,
  owner: string,
): Promise<void> {
  await prisma.computer.updateMany({
    where: { id: computerId, maintenanceId: owner },
    data: { maintenanceId: null },
  });
}

/** Hold the Computer read lock through the actual filesystem mutation. */
export async function withCheckpointWorkspaceWriteInTransaction<T>(
  tx: Prisma.TransactionClient,
  computerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const computers = await tx.$queryRaw<Array<{ maintenanceId: string | null }>>`
    SELECT "maintenanceId" FROM computers WHERE id = ${computerId} FOR SHARE
  `;
  if (computers.length !== 1 || computers[0]!.maintenanceId)
    throw new CheckpointConflictError("Workspace is undergoing checkpoint maintenance");
  return operation();
}

export async function withCheckpointWorkspaceWrite<T>(
  prisma: PrismaClient,
  computerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    (tx) => withCheckpointWorkspaceWriteInTransaction(tx, computerId, operation),
    { maxWait: 10_000, timeout: 120_000 },
  );
}
