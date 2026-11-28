import { randomUUID } from "node:crypto";
import type { AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor, Bot, ComputerMode } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, ClientError, computerUsingRuns } from "@rakazo/core";
import type { createRepos, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  computerScopeKey,
  expireComputerExecutionLeases,
  hasActiveComputerControl,
  IsolationError,
  isRecordNotFound,
  Prisma,
  recordComputerRunEnd,
  teamComputerUserId,
} from "@rakazo/db";
import { toComputerRef } from "./computer-lifecycle.js";
import { checkpointAndStopComputer } from "./computer-workspace.js";
import { endTeachingWithLease } from "./screens/computer-control.js";

export type BotComputerSwitchDeps = {
  prisma: PrismaClient;
  home: AgentHomeStore;
  sandbox: SandboxProvider;
  events: Pick<ThreadEvents, "draftRecordingsOfLease">;
  repos: Pick<ReturnType<typeof createRepos>, "getBot" | "setBotComputer">;
};

/**
 * Moves a bot between the Space's team computer and its own. Leaving its own computer saves and
 * stops it first, so nothing it was doing is lost; a bot that is working or being driven by a
 * person is refused instead.
 */
export async function switchBotComputer(
  deps: BotComputerSwitchDeps,
  actor: Actor,
  botId: string,
  mode: ComputerMode,
): Promise<{ bot: Bot; switched: boolean }> {
  const bot = await deps.repos.getBot(actor, botId);
  if (!bot.computer) throw new IsolationError();
  const currentMode = bot.computer.scope === "dedicated" ? "dedicated" : "team";
  if (currentMode === mode) {
    return { bot: await deps.repos.setBotComputer(actor, bot.id, mode), switched: false };
  }
  const destination = await deps.prisma.computer.findUnique({
    where: { scopeKey: computerScopeKey({
      mode, spaceId: actor.spaceId, botId: bot.id, userId: mode === "team"
        ? await teamComputerUserId(deps.prisma, actor) : actor.userId,
    }) },
    select: { id: true },
  });
  const ids = [...new Set([bot.computer.id, ...(destination ? [destination.id] : [])])].sort();
  const maintenanceId = `computer-switch:${randomUUID()}`;
  const claimed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM computers WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
    `);
    const computers = await tx.computer.findMany({
      where: { id: { in: ids }, spaceId: actor.spaceId, maintenanceId: null },
    });
    if (computers.length !== ids.length || computers.some((computer) => hasActiveComputerControl(computer)))
      throw new ClientError("CONFLICT", "Release the computer and let workspace maintenance finish first.");
    const active = await tx.run.findFirst({
      where: {
        OR: [{ botId: bot.id }, ...(destination ? [{ bot: { computerId: destination.id } }] : [])],
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { id: true },
    });
    if (active) throw new ClientError("BAD_REQUEST", "Stop workspace tasks first.");
    const result = await tx.bot.updateMany({
      where: { id: bot.id, computerId: bot.computerId, computerSwitching: false },
      data: { computerSwitching: true },
    });
    if (result.count === 1) await tx.computer.updateMany({
      where: { id: { in: ids } }, data: { maintenanceId },
    });
    return result;
  });
  if (claimed.count !== 1)
    throw new ClientError("CONFLICT", "The computer is busy; try again in a moment.");
  try {
    const active = await deps.prisma.run.findFirst({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] }, ...computerUsingRuns() },
      select: { id: true },
    });
    if (active) throw new ClientError("BAD_REQUEST", "Stop the bot first");
    if (bot.computer.controlBotId === bot.id && hasActiveComputerControl(bot.computer)) {
      throw new ClientError("BAD_REQUEST", "Release the computer first");
    }
    if (bot.computer.scope === "dedicated" && bot.computer.providerRef) {
      const context = createAdapterContext(actor, bot.id, "computer.switch");
      const ref = toComputerRef(bot.computer);
      if (bot.computer.state === "running") {
        await checkpointAndStopComputer(deps, bot.computer, ref, context);
      }
      await expireComputerExecutionLeases(deps.prisma, {
        computerId: bot.computer.id,
        botId: bot.id,
      });
      await deps.prisma.computer.update({
        where: { id: bot.computer.id },
        data: {
          state: "stopped",
          controlHolder: "none",
          controlLeaseId: null,
          controlUserId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
        },
      });
      await recordComputerRunEnd(deps.prisma, bot.computer, "stopped");
      await endTeachingWithLease(deps, actor.spaceId, bot.computer.controlLeaseId);
    }
    return { bot: await deps.repos.setBotComputer(actor, bot.id, mode, maintenanceId), switched: true };
  } catch (error) {
    // Removing the bot mid-switch also deletes its dedicated computer.
    if (isRecordNotFound(error)) throw new ClientError("NOT_FOUND", "Not Found");
    throw error;
  } finally {
    await deps.prisma.$transaction(async (tx) => {
      await tx.bot.updateMany({
        where: { id: bot.id }, data: { computerSwitching: false },
      });
      await tx.computer.updateMany({
        where: { id: { in: ids }, maintenanceId }, data: { maintenanceId: null },
      });
    });
  }
}
