import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  routineJobKey,
  routineRetryJob,
  routineWakeupJob,
  runContinueJob,
  TransientModelError,
} from "@rakazo/adapter-kit";
import { ROUTINE_WATCH_DEFAULT_MINUTES } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  displayName,
  expandSkillReferencesInPrompt,
  isOneShotRoutineCrons,
  nextRoutineRunDateAcross,
} from "@rakazo/core";
import {
  accountDeactivated,
  checkpointThreadLock,
  isUniqueViolation,
  SpaceDeletionInProgressError,
  spaceTakesWork,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { routineRunModelPin } from "../../models/model-selection.js";
import { protectedComputerLifecycleRefusal } from "../../providers/computer/desktop/desktop-command-guard.js";
import { pollRostJobWatch, StaleRostWatchError } from "../../rost-job-watch.js";
import { findPendingRoutineTick, routineTimerNonce } from "../../routines/routine-coalescing.js";
import {
  deleteEndedRoutine,
  deleteSpentRoutine,
  endRoutinePastItsEnd,
  runBeforeEnd,
} from "../../routines/routine-end.js";
import { routineGroupThreadId } from "../../routines/routine-thread.js";
import {
  nextRoutineWatchAt,
  parseRoutineWatch,
  tickRoutineWatch,
} from "../../routines/routine-watch.js";
import { listAgentSkillRecords } from "../../tools/skill-tools.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { notifyRun } from "../lifecycle/run-notifications.js";
import { wakeRun } from "../wakeups/wake-run.js";

/** A routine run stopped by a transient model error gets one more try this much later. */
const ROUTINE_RETRY_DELAY_MS = 12 * 60_000;

/** The retry is skipped when the routine's next occurrence is this close; that run covers it. */
const ROUTINE_RETRY_NEXT_RUN_WINDOW_MS = 30 * 60_000;

export async function deferFutureRoutine(
  jobs: JobPublisher,
  routineId: string,
  scheduledAt: Date,
): Promise<boolean> {
  if (scheduledAt.getTime() <= Date.now() + 1_000) return false;
  await jobs.enqueue(routineWakeupJob(routineId, scheduledAt));
  return true;
}

function routineNextRunIsNear(nextRunAt: Date | null, retryAt: number): boolean {
  return Boolean(nextRunAt && nextRunAt.getTime() - retryAt <= ROUTINE_RETRY_NEXT_RUN_WINDOW_MS);
}

/**
 * Queue one later retry of a routine run that a transient model error stopped before it posted
 * a message or called a tool. Effects are keyed to their run, so a retry after either could
 * repeat them. Returns whether a retry was queued.
 */
export async function scheduleRoutineRetry(
  deps: ExecutorDeps,
  run: {
    id: string;
    threadId: string;
    trigger: string;
    routineId: string | null;
    retryOfRunId: string | null;
  },
  error: unknown,
): Promise<boolean> {
  if (
    run.trigger !== "routine" ||
    !run.routineId ||
    run.retryOfRunId ||
    !(error instanceof TransientModelError)
  ) {
    return false;
  }
  try {
    const retryAt = Date.now() + ROUTINE_RETRY_DELAY_MS;
    const [routine, toolCalls, botMessages] = await Promise.all([
      deps.prisma.routine.findUnique({
        where: { id: run.routineId },
        select: { nextRunAt: true, jobWatch: true },
      }),
      deps.prisma.event.count({ where: { runId: run.id, type: "agent.tool.called" } }),
      deps.prisma.message.count({
        where: { threadId: run.threadId, runId: run.id, role: "bot" },
      }),
    ]);
    if (!routine || routine.jobWatch != null || toolCalls > 0 || botMessages > 0) return false;
    if (routineNextRunIsNear(routine.nextRunAt, retryAt)) return false;
    await deps.jobs.enqueue(routineRetryJob(run.id, new Date(retryAt)));
    return true;
  } catch (scheduleError) {
    getLogger().error("routine retry schedule", scheduleError);
    return false;
  }
}

async function notifyFailedRoutineRun(
  deps: ExecutorDeps,
  failed: Parameters<typeof notifyRun>[1] & { error: string | null },
  options: { retryOnFailure?: boolean } = {},
) {
  const bot = await deps.prisma.bot.findUniqueOrThrow({
    where: { id: failed.botId },
    select: { name: true },
  });
  await notifyRun(
    deps,
    failed,
    {
      kind: "failure",
      title: `${displayName(bot.name, "Bot")} failed`,
      body: failed.error ?? "",
      botId: failed.botId,
      threadId: failed.threadId,
    },
    options,
  );
}

/** The occurrence after `scheduledAt` for a timed routine; null once a one-time one has fired. */
function nextScheduledRunAt(
  routine: { crons: string[]; timezone: string },
  scheduledAt: Date,
): Date | null {
  return isOneShotRoutineCrons(routine.crons)
    ? null
    : nextRoutineRunDateAcross(routine.crons, scheduledAt, new Date(Date.now()), routine.timezone);
}

export async function wakeRoutine(deps: ExecutorDeps, routineId: string, scheduledFor: string) {
  const scheduledAt = new Date(scheduledFor);
  if (!Number.isFinite(scheduledAt.getTime())) return;
  const routine = await deps.prisma.routine.findUnique({
    where: { id: routineId },
    include: { space: { select: { deletingAt: true } } },
  });
  // A Space being deleted runs nothing; its routines resume if the deletion is called off.
  if (
    !routine?.active ||
    routine.space?.deletingAt ||
    routine.nextRunAt?.getTime() !== scheduledAt.getTime()
  )
    return;
  if (await deferFutureRoutine(deps.jobs, routineId, scheduledAt)) return;
  if (routine.endsAt && scheduledAt.getTime() > routine.endsAt.getTime()) {
    await endRoutinePastItsEnd(deps, routine, scheduledAt);
    return;
  }
  if (await accountDeactivated(deps.prisma, routine.userId)) {
    // A deactivated owner's routine skips this occurrence without running. A recurring or
    // watching one keeps its schedule, so it runs again once the owner is back; a one-time
    // one is spent. A watch that no longer parses keeps the default interval, so the normal
    // path reports it once the owner is back.
    const nextRunAt =
      routine.watch == null
        ? nextScheduledRunAt(routine, scheduledAt)
        : nextRoutineWatchAt(
            parseRoutineWatch(routine.watch) ?? { everyMinutes: ROUTINE_WATCH_DEFAULT_MINUTES },
            new Date(Math.max(Date.now(), scheduledAt.getTime())),
          );
    const skipped = await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: scheduledAt },
      data: { nextRunAt, ...(nextRunAt ? {} : { active: false }) },
    });
    if (skipped.count && nextRunAt)
      await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
    return;
  }
  const bot = await deps.prisma.bot.findUnique({
    where: { id: routine.botId },
    include: { thread: true },
  });
  if (bot?.archivedAt) {
    // Archiving pauses a bot's routines; re-pause one that slipped back to active.
    await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true },
      data: { active: false, nextRunAt: null, resumeOnRestore: true },
    });
    return;
  }
  if (!bot?.thread) return;
  const targetThreadId = await routineGroupThreadId(deps.prisma, routine, bot.id);
  const thread = targetThreadId ? { id: targetThreadId } : bot.thread;
  const jobWatchClaim = {
    id: routine.id,
    userId: routine.userId,
    active: true,
    nextRunAt: scheduledAt,
    updatedAt: routine.updatedAt,
    bot: { archivedAt: null },
  };
  let jobWatch: Awaited<ReturnType<typeof pollRostJobWatch>> | undefined;
  if (routine.jobWatch != null) {
    if (
      bot.userId !== routine.userId ||
      bot.spaceId !== routine.spaceId ||
      (routine.threadId != null && routine.threadId !== bot.thread.id) ||
      thread.id !== bot.thread.id ||
      routine.watch != null
    ) {
      await deps.prisma.routine.updateMany({
        where: jobWatchClaim,
        data: { active: false, nextRunAt: null },
      });
      return;
    }
    try {
      jobWatch = await pollRostJobWatch(
        deps,
        { userId: routine.userId, spaceId: routine.spaceId, botId: bot.id },
        routine.jobWatch,
      );
    } catch (error) {
      if (!(error instanceof StaleRostWatchError)) throw error;
      await deps.prisma.routine.updateMany({
        where: jobWatchClaim,
        data: { active: false, nextRunAt: null },
      });
      return;
    }
    if (!jobWatch.wakeReason) {
      const nextRunAt = runBeforeEnd(nextScheduledRunAt(routine, scheduledAt), routine.endsAt);
      const advanced = await deps.prisma.routine.updateMany({
        where: jobWatchClaim,
        data: { nextRunAt, active: nextRunAt !== null, jobWatch },
      });
      if (advanced.count === 1 && nextRunAt)
        await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
      return;
    }
  }
  // A change trigger checks first, without a model; only news becomes a run.
  const watchTick =
    jobWatch || routine.watch == null
      ? null
      : await tickRoutineWatch(
          { ...deps, commandRefusal: protectedComputerLifecycleRefusal },
          routine,
          { threadId: thread.id, botId: bot.id },
          scheduledAt,
        );
  if (watchTick && !watchTick.run) return;
  // A schedule with no valid parseable cron among its crons (e.g. a
  // legacy row accepted before cron validation was added) fires the
  // already-due run once, then nextRunAt stays null and the routine
  // pauses rather than crash-looping the wakeup job.
  const nextRunAt = jobWatch
    ? null
    : runBeforeEnd(
        watchTick?.run ? watchTick.nextRunAt : nextScheduledRunAt(routine, scheduledAt),
        routine.endsAt,
      );
  const lastRunBeforeEnd =
    !jobWatch &&
    routine.endsAt !== null &&
    nextRunAt === null &&
    !isOneShotRoutineCrons(routine.crons);
  const skillRecords = await listAgentSkillRecords(deps.prisma, {
    spaceId: routine.spaceId,
    userId: routine.userId,
  });
  const claimed = await deps.prisma.$transaction(async (tx) => {
    if (!(await spaceTakesWork(tx, routine.spaceId))) return null;
    await checkpointThreadLock(tx, thread.id);
    const branch = await tx.thread.findUnique({
      where: { id: thread.id },
      select: { activeBranchId: true, checkpointGeneration: true, checkpointBlocked: true },
    });
    if (
      !branch ||
      branch.checkpointBlocked ||
      (branch.checkpointGeneration ?? 0) !== (routine.checkpointGeneration ?? 0) ||
      (jobWatch && branch.checkpointGeneration !== jobWatch.checkpointGeneration)
    )
      return null;
    // The owner is part of the claim: a routine taken over mid-check runs as no one stale.
    const updated = await tx.routine.updateMany({
      where: {
        id: routine.id,
        userId: routine.userId,
        active: true,
        nextRunAt: scheduledAt,
        endsAt: routine.endsAt,
        ...(jobWatch ? { updatedAt: routine.updatedAt } : {}),
        bot: { archivedAt: null },
      },
      data: {
        lastRunAt: new Date(),
        nextRunAt,
        ...(nextRunAt || lastRunBeforeEnd ? {} : { active: false }),
        ...(watchTick?.run ? { watchState: watchTick.state } : {}),
        ...(jobWatch ? { jobWatch } : {}),
      },
    });
    if (updated.count !== 1) return null;
    // The claim locks the row, so the prompt and the model are the versions
    // committed when it fired; a prompt edit that lands while the tick gathers
    // its context must not pair with the newer model. Skill expansion runs on
    // the already-loaded list.
    const current = await tx.routine.findUnique({
      where: { id: routine.id },
      select: { prompt: true, modelProvider: true, modelId: true, thinkingLevel: true },
    });
    if (!current) return null;
    const routinePrompt =
      expandSkillReferencesInPrompt(current.prompt, skillRecords) +
      (jobWatch
        ? "\n\nToken-free Rost watch: " +
          JSON.stringify({
            out: jobWatch.out,
            reason: jobWatch.wakeReason,
            status: jobWatch.lastStatus,
            outcome: jobWatch.outcome,
            checkedAt: jobWatch.lastCheckedAt,
          }) +
          "\nInspect this existing job only. Never restart, extend, duplicate or change policy. " +
          "Completion is not approval or workbook validation. Observation failure requires attention, not a new solve."
        : "") +
      (watchTick?.run ? watchTick.note : "");
    const timerTick = !jobWatch && routine.watch == null && !isOneShotRoutineCrons(routine.crons);
    const timerNonce = timerTick ? routineTimerNonce(routine.id, scheduledFor) : undefined;
    if (timerNonce) {
      const pending = await findPendingRoutineTick(tx, {
        routineId: routine.id,
        spaceId: routine.spaceId,
        botId: bot.id,
        userId: routine.userId,
        threadId: thread.id,
        prompt: routinePrompt,
        ...routineRunModelPin(current),
      });
      if (pending) return { ...pending, coalesced: true };
      // Check after coalescing: a queued tick can be claimed while the lookup tries to reuse it.
      // It still owns this timer's work until it finishes or its question is answered and resumed.
      const activeTick = await tx.run.findFirst({
        where: {
          routineId: routine.id,
          userId: routine.userId,
          trigger: "routine",
          status: { in: [...ACTIVE_RUN_STATUSES] },
          clientNonce: { startsWith: routineTimerNonce(routine.id, "") },
        },
        select: { id: true },
      });
      if (activeTick) return "skipped" as const;
      // An edit racing an earlier tick can rewind the schedule onto an occurrence that already ran.
      const fired = await tx.run.findUnique({
        where: { spaceId_clientNonce: { spaceId: routine.spaceId, clientNonce: timerNonce } },
        select: { id: true },
      });
      if (fired) return "skipped" as const;
    }
    const task = await tx.task.create({
      data: {
        spaceId: routine.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: routine.userId,
        prompt: routinePrompt,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: routine.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: routine.userId,
        status: "queued",
        trigger: "routine",
        routineId: routine.id,
        clientNonce: timerNonce,
        branchId: branch.activeBranchId,
        checkpointGeneration: branch.checkpointGeneration,
        ...routineRunModelPin(current),
      },
    });
    return { ...run, coalesced: false };
  });
  if (!claimed) return;
  if (claimed === "skipped") {
    if (nextRunAt) await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
    else if (routine.endsAt) {
      await deleteSpentRoutine(deps, {
        spaceId: routine.spaceId,
        routineId: routine.id,
        userId: routine.userId,
      });
    }
    return;
  }
  if ("cancelledEvents" in claimed && claimed.cancelledEvents) {
    for (const event of claimed.cancelledEvents) {
      await deps.events.notify(event.threadId, event.seq);
    }
  }
  // Enqueue continuation first so a thread-signal failure cannot strand the run.
  await wakeRun(deps.jobs, claimed.id, { keepExisting: claimed.coalesced });
  if (claimed.coalesced) {
    getLogger().info("routine.coalesced", {
      "routine.id": routine.id,
      "run.id": claimed.id,
    });
  }
  try {
    if (!claimed.coalesced)
      await deps.events.append({
        spaceId: routine.spaceId,
        threadId: thread.id,
        botId: bot.id,
        type: "routine.fired",
        runId: claimed.id,
        payload: { routineId: routine.id, scheduledFor },
      });
  } catch {
    // Best effort: the run is already queued.
  }
  if (nextRunAt) {
    await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
  } else if (!jobWatch) {
    try {
      await deps.jobs.cancel(routineJobKey(routine.id));
    } catch {
      // Best effort: the run is already queued for continuation.
    }
  }
}

export async function notifyRoutineRetryAttemptsExhausted(deps: ExecutorDeps, runId: string) {
  const failed = await deps.prisma.run.findUnique({ where: { id: runId } });
  if (
    !failed?.routineId ||
    failed.trigger !== "routine" ||
    failed.status !== "failed" ||
    failed.retryOfRunId
  ) {
    return;
  }
  const supersedingRun = await deps.prisma.run.findFirst({
    where: {
      OR: [
        { retryOfRunId: failed.id },
        { routineId: failed.routineId, createdAt: { gt: failed.createdAt } },
      ],
    },
    select: { id: true },
  });
  if (supersedingRun) return;
  await notifyFailedRoutineRun(deps, failed, { retryOnFailure: true });
  await deleteEndedRoutine(deps, failed);
}

export async function retryRoutineRun(deps: ExecutorDeps, runId: string) {
  const failed = await deps.prisma.run.findUnique({ where: { id: runId } });
  if (
    !failed?.routineId ||
    failed.trigger !== "routine" ||
    failed.status !== "failed" ||
    failed.retryOfRunId
  ) {
    return;
  }
  const routine = await deps.prisma.routine.findUnique({
    where: { id: failed.routineId },
    select: {
      active: true,
      crons: true,
      jobWatch: true,
      nextRunAt: true,
      userId: true,
      bot: { select: { archivedAt: true } },
      space: { select: { deletingAt: true } },
    },
  });
  // As in wakeRoutine: a Space being deleted runs nothing.
  if (routine?.space?.deletingAt) return;
  const laterRun = await deps.prisma.run.findFirst({
    where: { routineId: failed.routineId, createdAt: { gt: failed.createdAt } },
    select: { id: true },
  });
  if (laterRun) return;
  const notifyAbandonedRetry = async () => {
    await notifyFailedRoutineRun(deps, failed, { retryOnFailure: true });
    await deleteEndedRoutine(deps, failed);
  };
  if (routine?.jobWatch != null) {
    await notifyAbandonedRetry();
    return;
  }
  if (routine && routineNextRunIsNear(routine.nextRunAt, Date.now())) {
    await notifyAbandonedRetry();
    return;
  }
  // A one-time routine turns itself off when it fires, so only a recurring one counts as paused.
  // A routine someone else has since taken over must not retry on its former owner's accounts.
  if (
    !routine ||
    routine.userId !== failed.userId ||
    (!routine.active && !isOneShotRoutineCrons(routine.crons)) ||
    routine.bot.archivedAt
  ) {
    await notifyAbandonedRetry();
    return;
  }
  const task = await deps.prisma.task.findUnique({
    where: { id: failed.taskId },
    select: { prompt: true },
  });
  if (!task) {
    await notifyAbandonedRetry();
    return;
  }
  let retry: { id: string; taskId: string } | null;
  try {
    retry = await deps.prisma.$transaction(async (tx) => {
      if (!(await spaceTakesWork(tx, failed.spaceId))) throw new SpaceDeletionInProgressError();
      await checkpointThreadLock(tx, failed.threadId);
      const branch = await tx.thread.findUniqueOrThrow({
        where: { id: failed.threadId },
        select: { activeBranchId: true, checkpointGeneration: true, checkpointBlocked: true },
      });
      if (
        branch.checkpointBlocked ||
        (failed.checkpointGeneration ?? 0) !== (branch.checkpointGeneration ?? 0) ||
        (failed.branchId ?? null) !== (branch.activeBranchId ?? null)
      )
        return null;
      // Claim the still-eligible routine without changing its state. One-shot routines
      // may already be inactive; match their crons so an edit cannot revive a paused routine.
      const claimed = await tx.routine.updateMany({
        where: {
          id: failed.routineId!,
          userId: failed.userId,
          active: routine.active,
          ...(!routine.active ? { crons: { equals: routine.crons } } : {}),
          bot: { archivedAt: null },
        },
        data: { active: routine.active },
      });
      if (claimed.count !== 1) return null;
      const laterRun = await tx.run.findFirst({
        where: { routineId: failed.routineId!, createdAt: { gt: failed.createdAt } },
        select: { id: true },
      });
      if (laterRun) return null;
      const targetThread = await tx.thread.findFirst({
        where: {
          id: failed.threadId,
          spaceId: failed.spaceId,
          OR: [
            { botId: failed.botId },
            {
              group: {
                archivedAt: null,
                members: { some: { botId: failed.botId } },
              },
            },
          ],
        },
        select: { id: true },
      });
      if (!targetThread) return null;
      const retryTask = await tx.task.create({
        data: {
          spaceId: failed.spaceId,
          botId: failed.botId,
          threadId: failed.threadId,
          userId: failed.userId,
          prompt: task.prompt,
          status: "queued",
        },
      });
      return tx.run.create({
        data: {
          spaceId: failed.spaceId,
          botId: failed.botId,
          threadId: failed.threadId,
          taskId: retryTask.id,
          userId: failed.userId,
          status: "queued",
          trigger: "routine",
          routineId: failed.routineId,
          retryOfRunId: failed.id,
          checkpointGeneration: branch.checkpointGeneration ?? 0,
          branchId: branch.activeBranchId ?? null,
          ...(failed.modelPinned
            ? {
                modelProvider: failed.modelProvider,
                modelId: failed.modelId,
                thinkingLevel: failed.thinkingLevel,
                modelPinned: true,
              }
            : {}),
        },
      });
    });
  } catch (error) {
    // retryOfRunId is unique: another delivery of this job already queued the retry.
    if (isUniqueViolation(error)) return;
    if (error instanceof SpaceDeletionInProgressError) return;
    throw error;
  }
  if (!retry) {
    const laterRun = await deps.prisma.run.findFirst({
      where: { routineId: failed.routineId, createdAt: { gt: failed.createdAt } },
      select: { id: true },
    });
    if (laterRun) return;
    await notifyAbandonedRetry();
    return;
  }
  try {
    await deps.jobs.enqueue(runContinueJob(retry.id));
  } catch (error) {
    // Remove the retry so the job queue's own retry of this job can queue it again.
    const queuedRetry = retry;
    await deps.prisma.$transaction(async (tx) => {
      const removed = await tx.run.deleteMany({
        where: { id: queuedRetry.id, status: "queued" },
      });
      if (removed.count === 1) {
        await tx.task.deleteMany({ where: { id: queuedRetry.taskId, status: "queued" } });
      }
    });
    throw error;
  }
}
