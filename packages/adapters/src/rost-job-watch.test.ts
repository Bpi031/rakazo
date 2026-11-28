import type { SandboxProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { wakeRoutine } from "./runs/assembly/run-routines.js";
import { createScheduleFromTool } from "./schedule-tools.js";

vi.mock("./routines/routine-watch.js", () => ({
  nextRoutineWatchAt: vi.fn(),
  parseRoutineWatch: vi.fn(),
  tickRoutineWatch: vi.fn(() => {
    throw new Error("A Rost job must not use an upstream change watch");
  }),
}));

import {
  assertRostWatchTriggers,
  createRostJobWatch,
  pollRostJobWatch,
  RostJobOut,
  reduceRostWatch,
} from "./rost-job-watch.js";

const observation = {
  binding: "a".repeat(64),
  deadlineUtc: Date.now() / 1000 + 21600,
  status: "running",
};
const watch = {
  schema: "rost/job-watch/v1" as const,
  out: "case/owned-job",
  computerId: "computer",
  binding: observation.binding,
  deadlineUtc: observation.deadlineUtc,
  checks: 0,
  failures: 0,
};
const scope = { userId: "user", spaceId: "space", botId: "bot" };
const createRunExecutor = (deps: Parameters<typeof wakeRoutine>[0]) => ({
  wakeRoutine: (id: string, due: string) => wakeRoutine(deps, id, due),
});
function fixture(status = "running") {
  const due = new Date(Date.now() - 1000);
  const routine = {
    id: "routine",
    ...scope,
    prompt: "Validate and export the existing result",
    crons: ["* * * * *"],
    timezone: "UTC",
    active: true,
    nextRunAt: due,
    updatedAt: due,
    lastRunAt: null,
    threadId: "thread",
    jobWatch: { ...watch } as typeof watch & { lastStatus?: string },
    checkpointGeneration: 0,
    endsAt: null,
    watch: null,
  };
  const bot = {
    id: "bot",
    userId: "user",
    spaceId: "space",
    archivedAt: null,
    computerId: "computer",
    thread: {
      id: "thread",
      checkpointGeneration: 0,
      checkpointBlocked: false,
      activeBranchId: null,
    },
    computer: {
      id: "computer",
      userId: "user",
      spaceId: "space",
      scope: "dedicated",
      state: "running",
      providerRef: "private",
    },
  };
  const taskCreate = vi.fn(async (_input: { data: { prompt: string } }) => ({ id: "task" }));
  const runCreate = vi.fn(async () => ({ id: "run", taskId: "task" }));
  const update = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { nextRunAt?: Date | null; active?: boolean; updatedAt?: Date };
      data: Partial<typeof routine>;
    }) => {
      if (
        where.nextRunAt?.getTime() !== routine.nextRunAt?.getTime() ||
        where.active !== routine.active ||
        (where.updatedAt && where.updatedAt !== routine.updatedAt)
      )
        return { count: 0 };
      Object.assign(routine, data, { updatedAt: new Date() });
      return { count: 1 };
    },
  );
  const db = {
    space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
    user: { findUnique: vi.fn(async () => ({ deactivatedAt: null })) },
    spaceMember: {
      findUnique: vi.fn(
        async (): Promise<{ organizationId: string; member: { role: string } } | null> => ({
          organizationId: "org",
          member: { role: "owner" },
        }),
      ),
    },
    teamMemberControl: { findUnique: vi.fn(async () => null) },
    routine: {
      findUnique: vi.fn(async () => ({ ...routine })),
      updateMany: update,
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "new-watch",
      })),
    },
    bot: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => bot),
      findFirstOrThrow: vi.fn(async () => bot),
    },
    thread: {
      findFirst: vi.fn(async () => bot.thread),
      findUnique: vi.fn(async (): Promise<Partial<typeof bot.thread>> => bot.thread),
      findUniqueOrThrow: vi.fn(async () => bot.thread),
    },
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => []),
    agentSkill: { findMany: vi.fn(async () => []) },
    task: { create: taskCreate, deleteMany: vi.fn(async () => ({})) },
    run: { create: runCreate, deleteMany: vi.fn(async () => ({})) },
  };
  const prisma = Object.assign(db, {
    $transaction: <T>(f: (tx: typeof db) => Promise<T>) => f(db),
  });
  const execute = vi.fn<SandboxProvider["execute"]>(async function* () {
    yield { type: "stdout", data: JSON.stringify({ ...observation, status }) };
    yield { type: "exit", code: 0 };
  });
  const deps = {
    prisma,
    sandbox: { execute },
    jobs: { enqueue: vi.fn(async () => {}), cancel: vi.fn(), close: vi.fn() },
    events: { append: vi.fn() },
  };
  return {
    deps: deps as unknown as typeof deps & Parameters<typeof wakeRoutine>[0],
    db,
    routine,
    due,
    execute,
    taskCreate,
    runCreate,
  };
}

describe("token-free owned Rost watch", () => {
  it("observes Team own outputs and shared outputs, rejects another Bot and account", async () => {
    const f = fixture();
    const bot = await f.db.bot.findFirstOrThrow();
    bot.computer.scope = "team";
    await createRostJobWatch(f.deps, scope, "case/job");
    expect(f.execute.mock.calls[0]![1].argv.slice(4)).toEqual(["case/job", "bots/bot"]);
    await createRostJobWatch(f.deps, scope, "shared/case/job");
    expect(f.execute.mock.calls[1]![1].argv.slice(4)).toEqual(["case/job", "shared"]);
    await expect(createRostJobWatch(f.deps, scope, "bots/other/job")).rejects.toThrow("outside");
    f.db.bot.count.mockResolvedValue(1);
    await expect(createRostJobWatch(f.deps, scope, "case/job")).rejects.toThrow("exclusively");
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it("rejects absolute, traversal, control and ambiguous paths and non-timer triggers", () => {
    for (const path of [
      "/tmp/job",
      "../job",
      "a//b",
      "a/./b",
      "a/../b",
      "a\0b",
      "a\\b",
      "",
      "workspace",
      "workspace/case/job",
    ])
      expect(RostJobOut.safeParse(path).success).toBe(false);
    expect(RostJobOut.parse("case/job")).toBe("case/job");
    for (const input of [
      { crons: [] },
      { crons: ["@once"] },
      { crons: ["* * * * *"], webhookEnabled: true },
      { crons: ["* * * * *"], githubEnabled: true },
      { crons: ["* * * * *"], messageProvider: "chat" },
    ])
      expect(() => assertRostWatchTriggers(watch, input)).toThrow();
  });
  it("returns recoverable tool argument errors without database, shell, queue or model work", async () => {
    const f = fixture();
    for (const rostJobOut of [
      "/home/rakazo/workspace/case/owned-job",
      "workspace/case/owned-job",
      "../job",
      "a//b",
      "",
      "a\0b",
    ]) {
      expect(
        await createScheduleFromTool(f.deps, {
          ...scope,
          threadId: "thread",
          name: "Completion",
          prompt: "Validate existing result",
          rostJobOut,
          schedule: { every: 1, unit: "minutes" },
        }),
      ).toMatchObject({
        code: "ROST_JOB_WATCH_ARGUMENTS",
        fields: ["rostJobOut"],
        watchCreated: false,
        solveStarted: false,
      });
    }
    expect(
      await createScheduleFromTool(f.deps, {
        ...scope,
        threadId: "thread",
        name: "Completion",
        prompt: "Validate existing result",
        rostJobOut: watch.out,
        schedule: { delayMinutes: 10 },
      }),
    ).toMatchObject({
      code: "ROST_JOB_WATCH_ARGUMENTS",
      fields: ["schedule"],
      watchCreated: false,
      solveStarted: false,
    });
    expect(f.db.bot.findFirstOrThrow).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(f.deps.events.append).not.toHaveBeenCalled();
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.taskCreate).not.toHaveBeenCalled();
  });
  it("all active lifecycle phases and quality stalls never wake a model", () => {
    for (const status of ["reserved", "preparing", "starting", "running", "stopping", "checking"]) {
      const result = reduceRostWatch(watch, { ...observation, status });
      expect(result.wakeReason).toBeUndefined();
      expect(result.failures).toBe(0);
      expect(result.lastStatus).toBe(status);
    }
  });
  it.each(["starting", "checking"])("registers and polls %s without model work", async (status) => {
    const f = fixture(status);
    expect(
      await createScheduleFromTool(f.deps, {
        ...scope,
        threadId: "thread",
        name: "Completion",
        prompt: "Inspect the existing result",
        rostJobOut: watch.out,
        schedule: { every: 1, unit: "minutes" },
      }),
    ).toMatchObject({ ok: true, monitor: "token_free_rost_job" });
    expect(f.db.routine.create).toHaveBeenCalledTimes(1);
    await createRunExecutor(f.deps).wakeRoutine("routine", f.due.toISOString());
    expect(f.routine.jobWatch.lastStatus).toBe(status);
    expect(f.routine.jobWatch.failures).toBe(0);
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.taskCreate).not.toHaveBeenCalled();
    expect(f.db.agentSkill.findMany).not.toHaveBeenCalled();
  });
  it.each([
    "unknown-status",
    "missing-status",
    "malformed-json",
    "bad-exit",
    "transport",
    "oversize",
  ])(
    "returns a monitoring tool error for %s without publishing a watch or aborting into a provider error",
    async (kind) => {
      const f = fixture();
      f.execute.mockImplementation(async function* () {
        if (kind === "transport") throw new Error("private internal transport detail");
        const data =
          kind === "malformed-json"
            ? "broken"
            : kind === "oversize"
              ? "x".repeat(8193)
              : JSON.stringify({
                  ...observation,
                  status:
                    kind === "missing-status"
                      ? undefined
                      : kind === "unknown-status"
                        ? "unexpected_phase"
                        : "running",
                });
        yield { type: "stdout", data };
        yield { type: "exit", code: kind === "bad-exit" ? 1 : 0 };
      });
      const result = await createScheduleFromTool(f.deps, {
        ...scope,
        threadId: "thread",
        name: "Completion",
        prompt: "Inspect result",
        rostJobOut: watch.out,
        schedule: { every: 1, unit: "minutes" },
      });
      expect(result).toMatchObject({
        code: "ROST_JOB_WATCH_OBSERVATION",
        watchCreated: false,
        solveStarted: false,
        existingJobUnchanged: true,
      });
      expect(JSON.stringify(result)).not.toContain("private internal");
      expect(f.db.routine.create).not.toHaveBeenCalled();
      expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
      expect(f.deps.events.append).not.toHaveBeenCalled();
      expect(f.runCreate).not.toHaveBeenCalled();
    },
  );
  it("does not convert denied membership into a retriable monitoring error", async () => {
    const f = fixture();
    f.db.spaceMember.findUnique.mockResolvedValue(null);
    await expect(
      createScheduleFromTool(f.deps, {
        ...scope,
        threadId: "thread",
        name: "Completion",
        prompt: "Inspect result",
        rostJobOut: watch.out,
        schedule: { every: 1, unit: "minutes" },
      }),
    ).rejects.toThrow(/membership/);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.db.routine.create).not.toHaveBeenCalled();
  });
  it("completion, failure and explicit recovery need exactly one attention event", () => {
    for (const [status, reason] of [
      ["completed", "completion"],
      ["stopped", "completion"],
      ["failed", "failure"],
      ["recovery_required", "required_decision"],
    ]) {
      const result = reduceRostWatch(watch, { ...observation, status });
      expect(result.wakeReason).toBe(reason);
      expect(() => reduceRostWatch(result, observation)).toThrow(/consumed/);
    }
    expect(
      reduceRostWatch(watch, { ...observation, observedStatus: "recovery_required" }).wakeReason,
    ).toBe("required_decision");
  });
  it("transient missing/malformed/drifted observations retry silently, then ask once without restarting", () => {
    let current: typeof watch & Partial<ReturnType<typeof reduceRostWatch>> = watch;
    for (let i = 1; i <= 3; i++) {
      current = reduceRostWatch(
        current,
        i === 1 ? undefined : { ...observation, binding: "b".repeat(64) },
      );
      expect(current.failures).toBe(i);
      expect(current.wakeReason).toBe(i === 3 ? "required_decision" : undefined);
    }
    const failed = reduceRostWatch(watch, undefined);
    expect(reduceRostWatch(failed, observation).failures).toBe(0);
    expect(
      reduceRostWatch(watch, observation, new Date((observation.deadlineUtc + 181) * 1000))
        .wakeReason,
    ).toBe("required_decision");
  });
  it("unknown future phases fail closed after bounded token-free polling, never as completion", async () => {
    const f = fixture("future_phase");
    let current: typeof watch & Partial<ReturnType<typeof reduceRostWatch>> = watch;
    for (let attempt = 1; attempt <= 3; attempt++) {
      current = await pollRostJobWatch(f.deps, scope, current);
      expect(current.failures).toBe(attempt);
      expect(current.wakeReason).toBe(attempt === 3 ? "required_decision" : undefined);
      expect(current.lastStatus).toBe("observation_unavailable");
    }
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
  });
  it("registration requires current private ownership, membership and the originating private thread", async () => {
    const f = fixture();
    expect((await createRostJobWatch(f.deps, scope, watch.out, "thread")).binding).toBe(
      watch.binding,
    );
    await expect(createRostJobWatch(f.deps, scope, watch.out, "other-thread")).rejects.toThrow(
      /private/,
    );
    f.db.spaceMember.findUnique.mockResolvedValue(null);
    await expect(createRostJobWatch(f.deps, scope, watch.out)).rejects.toThrow(/membership/);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it("read command is fixed and never starts, stops or extends a job", async () => {
    const f = fixture();
    await pollRostJobWatch(f.deps, scope, watch);
    const args = f.execute.mock.calls[0]!;
    expect(args[1].argv.slice(0, 3)).toEqual(["/opt/office-python/bin/python3", "-I", "-c"]);
    expect(args[1].argv[4]).toBe(watch.out);
    expect(args[1].timeoutMs).toBe(15000);
  });
  it("rejects a late completion after checkpoint generation changes without waking a model", async () => {
    const f = fixture("completed");
    f.execute.mockImplementation(async function* () {
      f.db.thread.findUnique.mockResolvedValue({
        checkpointGeneration: 1,
        checkpointBlocked: false,
      });
      yield {
        type: "stdout",
        data: JSON.stringify({ ...observation, status: "completed", outcome: "proven_infeasible" }),
      };
      yield { type: "exit", code: 0 };
    });
    await createRunExecutor(f.deps).wakeRoutine("routine", f.due.toISOString());
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.taskCreate).not.toHaveBeenCalled();
    expect(f.routine.active).toBe(false);
  });
  it("rejects an old watch before reading the sandbox", async () => {
    const f = fixture();
    f.db.thread.findUnique.mockResolvedValue({ checkpointGeneration: 1, checkpointBlocked: false });
    await expect(pollRostJobWatch(f.deps, scope, watch)).rejects.toThrow(/inactive checkpoint/);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("retries database failures without disabling the watch", async () => {
    const f = fixture();
    const error = new Error("database temporarily unavailable");
    f.db.thread.findUnique.mockRejectedValue(error);
    await expect(
      createRunExecutor(f.deps).wakeRoutine("routine", f.due.toISOString()),
    ).rejects.toBe(error);
    expect(f.routine.active).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
  });
  it("executor reschedules running observations without task, run, event or model resolution", async () => {
    const f = fixture();
    await createRunExecutor(f.deps).wakeRoutine("routine", f.due.toISOString());
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.taskCreate).not.toHaveBeenCalled();
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.db.agentSkill.findMany).not.toHaveBeenCalled();
    expect(f.deps.events.append).not.toHaveBeenCalled();
    expect(f.deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "routine.wakeup" }),
    );
    expect(f.routine.jobWatch.checks).toBe(1);
    expect(f.routine.lastRunAt).toBe(null);
  });
  it("duplicate terminal wakeups fence one queued continuation and consume the watch", async () => {
    const f = fixture("completed"),
      executor = createRunExecutor(f.deps);
    f.execute.mockImplementation(async function* () {
      yield {
        type: "stdout",
        data: JSON.stringify({
          ...observation,
          status: "completed",
          outcome: "candidate_needs_validation",
        }),
      };
      yield { type: "exit", code: 0 };
    });
    await Promise.all([
      executor.wakeRoutine("routine", f.due.toISOString()),
      executor.wakeRoutine("routine", f.due.toISOString()),
    ]);
    expect(f.runCreate).toHaveBeenCalledTimes(1);
    expect(f.taskCreate).toHaveBeenCalledTimes(1);
    expect(f.routine.active).toBe(false);
    expect(f.routine.nextRunAt).toBe(null);
    expect(f.taskCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ prompt: expect.stringContaining('"reason":"completion"') }),
      }),
    );
    expect(f.taskCreate.mock.calls[0]?.[0].data.prompt).toContain(
      '"outcome":"candidate_needs_validation"',
    );
    expect(f.deps.jobs.enqueue).toHaveBeenCalledTimes(1);
  });
  it("a routine edit or cancellation during observation wins the claim", async () => {
    const f = fixture("completed");
    f.execute.mockImplementation(async function* () {
      f.routine.updatedAt = new Date(Date.now() + 1);
      yield { type: "stdout", data: JSON.stringify({ ...observation, status: "completed" }) };
      yield { type: "exit", code: 0 };
    });
    await createRunExecutor(f.deps).wakeRoutine("routine", f.due.toISOString());
    expect(f.runCreate).not.toHaveBeenCalled();
  });
  it("queue failure leaves one durable continuation, not a re-armed watcher", async () => {
    const f = fixture("completed"),
      executor = createRunExecutor(f.deps);
    f.deps.jobs.enqueue.mockRejectedValue(new Error("queue unavailable"));
    await executor.wakeRoutine("routine", f.due.toISOString());
    expect(f.routine.active).toBe(false);
    expect(f.runCreate).toHaveBeenCalledTimes(1);
    await executor.wakeRoutine("routine", f.due.toISOString());
    expect(f.runCreate).toHaveBeenCalledTimes(1);
    expect(f.db.run.deleteMany).not.toHaveBeenCalled();
  });
});
