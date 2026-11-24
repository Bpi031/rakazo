import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { CheckpointConflictError } from "./checkpoints.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

export interface CheckpointWorkspaceClaim {
  computerId: string;
  spaceId: string;
  userId: string;
  botId: string;
  owner: string;
  allowedRunId?: string;
  restore?: boolean;
  retry?: { threadId: string; expectedGeneration: number };
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
          checkpointBlocked: true,
          checkpointGeneration: input.retry.expectedGeneration,
        },
        select: { id: true },
      });
      const failed = thread
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
      if (
        !details ||
        typeof details !== "object" ||
        Array.isArray(details) ||
        details.workspaceMaintenanceOwner !== computer.maintenanceId ||
        details.workspaceComputerId !== input.computerId
      )
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
          ((input.restore && computer.controlBotId === input.botId) ||
            (input.allowedRunId && computer.controlRunId === input.allowedRunId))
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
