import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { assertRostWatchTriggers, createRostJobWatch, pollRostJobWatch, reduceRostWatch, RostJobOut } from "./rost-job-watch.js";

const observation = { binding: "a".repeat(64), deadlineUtc: Date.now()/1000 + 21600, status: "running" };
const watch = { schema: "rost/job-watch/v1", out: "case/owned-job", computerId: "computer", binding: observation.binding,
  deadlineUtc: observation.deadlineUtc, checks: 0, failures: 0 };
const scope = { userId: "user", spaceId: "space", botId: "bot" };
function fixture(status = "running") {
  const due = new Date(Date.now() - 1000);
  const routine: any = { id: "routine", ...scope, prompt: "Validate and export the existing result", crons: ["* * * * *"], timezone: "UTC",
    active: true, nextRunAt: due, updatedAt: due, lastRunAt: null, threadId: "thread", jobWatch: {...watch} };
  const bot = { id: "bot", userId: "user", spaceId: "space", archivedAt: null, computerId: "computer",
    thread: {id: "thread"}, computer: {id: "computer", userId: "user", spaceId: "space", scope: "dedicated", state: "running", providerRef: "private"} };
  const taskCreate = vi.fn(async (_input: any) => ({ id: "task" }));
  const runCreate = vi.fn(async () => ({ id: "run", taskId: "task" }));
  const update = vi.fn(async ({where, data}) => {
    if (where.nextRunAt?.getTime() !== routine.nextRunAt?.getTime() || where.active !== routine.active
        || (where.updatedAt && where.updatedAt !== routine.updatedAt)) return { count: 0 };
    Object.assign(routine, data, {updatedAt: new Date()});
    return { count: 1 };
  });
  const db: any = {
    spaceMember: {findUnique: vi.fn(async () => ({organizationId: "org", member: {role: "owner"}}))},
    teamMemberControl: {findUnique: vi.fn(async () => null)},
    routine: {findUnique: vi.fn(async () => ({...routine})), updateMany: update},
    bot: { findUnique: vi.fn(async () => bot), findFirstOrThrow: vi.fn(async () => bot) },
    thread: {findFirst: vi.fn(async () => ({id: "thread"}))},
    agentSkill: {findMany: vi.fn(async () => [])},
    task: {create: taskCreate, deleteMany: vi.fn(async () => ({}))},
    run: {create: runCreate, deleteMany: vi.fn(async () => ({}))},
  };
  db.$transaction = async (f: any) => f(db);
  const execute = vi.fn(async function* () {
    yield {type: "stdout", data: JSON.stringify({...observation, status})};
    yield {type: "exit", code: 0};
  });
  const deps: any = {prisma: db, sandbox: {execute}, jobs: {enqueue: vi.fn(async () => {}), cancel: vi.fn(), close: vi.fn()}, events: {append: vi.fn()}};
  return {deps, db, routine, due, execute, taskCreate, runCreate};
}

describe("token-free owned Rost watch", () => {
  it("rejects absolute, traversal, control and ambiguous paths and non-timer triggers", () => {
    for (const path of ["/tmp/job", "../job", "a//b", "a/./b", "a/../b", "a\0b", "a\\b", ""]) expect(RostJobOut.safeParse(path).success).toBe(false);
    expect(RostJobOut.parse("case/job")).toBe("case/job");
    for (const input of [{crons: []}, {crons:["@once"]}, {crons:["* * * * *"], webhookEnabled:true}, {crons:["* * * * *"], githubEnabled:true}, {crons:["* * * * *"], messageProvider:"chat"}])
      expect(() => assertRostWatchTriggers(watch, input)).toThrow();
  });
  it("running/stopping/preparing and quality stalls never wake a model", () => {
    for (const status of ["reserved", "preparing", "running", "stopping"]) expect(reduceRostWatch(watch, {...observation,status}).wakeReason).toBeUndefined();
  });
  it("completion, failure and explicit recovery need exactly one attention event", () => {
    for (const [status,reason] of [["completed","completion"],["stopped","completion"],["failed","failure"],["recovery_required","required_decision"]]) {
      const result = reduceRostWatch(watch, {...observation,status});
      expect(result.wakeReason).toBe(reason);
      expect(() => reduceRostWatch(result, observation)).toThrow(/consumed/);
    }
    expect(reduceRostWatch(watch, {...observation,observedStatus:"recovery_required"}).wakeReason).toBe("required_decision");
  });
  it("transient missing/malformed/drifted observations retry silently, then ask once without restarting", () => {
    let current: any = watch;
    for (let i=1; i<=3; i++) {
      current = reduceRostWatch(current, i===1 ? undefined : {...observation,binding:"b".repeat(64)});
      expect(current.failures).toBe(i);
      expect(current.wakeReason).toBe(i===3 ? "required_decision" : undefined);
    }
    const failed = reduceRostWatch(watch, undefined);
    expect(reduceRostWatch(failed, observation).failures).toBe(0);
    expect(reduceRostWatch(watch, observation, new Date((observation.deadlineUtc+181)*1000)).wakeReason).toBe("required_decision");
  });
  it("registration requires current private ownership, membership and the originating private thread", async () => {
    const f = fixture();
    expect((await createRostJobWatch(f.deps, scope, watch.out, "thread")).binding).toBe(watch.binding);
    await expect(createRostJobWatch(f.deps, scope, watch.out, "other-thread")).rejects.toThrow(/private/);
    f.db.spaceMember.findUnique.mockResolvedValue(null);
    await expect(createRostJobWatch(f.deps, scope, watch.out)).rejects.toThrow(/membership/);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it("read command is fixed and never starts, stops or extends a job", async () => {
    const f=fixture(); await pollRostJobWatch(f.deps, scope, watch);
    const args:any=f.execute.mock.calls[0];
    expect(args[1].argv.slice(0,3)).toEqual(["/opt/office-python/bin/python3","-I","-c"]);
    expect(args[1].argv[4]).toBe(watch.out);
    expect(args[1].timeoutMs).toBe(15000);
  });
  it("executor reschedules running observations without task, run, event or model resolution", async () => {
    const f=fixture();
    await createRunExecutor(f.deps).wakeRoutine("routine",f.due.toISOString());
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.taskCreate).not.toHaveBeenCalled(); expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.db.agentSkill.findMany).not.toHaveBeenCalled(); expect(f.deps.events.append).not.toHaveBeenCalled();
    expect(f.deps.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({name:"routine.wakeup"}));
    expect(f.routine.jobWatch.checks).toBe(1); expect(f.routine.lastRunAt).toBe(null);
  });
  it("duplicate terminal wakeups fence one queued continuation and consume the watch", async () => {
    const f=fixture("completed"), executor=createRunExecutor(f.deps);
    await Promise.all([executor.wakeRoutine("routine",f.due.toISOString()),executor.wakeRoutine("routine",f.due.toISOString())]);
    expect(f.runCreate).toHaveBeenCalledTimes(1); expect(f.taskCreate).toHaveBeenCalledTimes(1);
    expect(f.routine.active).toBe(false); expect(f.routine.nextRunAt).toBe(null);
    expect(f.taskCreate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({data:expect.objectContaining({prompt:expect.stringContaining('"reason":"completion"')})}));
    expect(f.deps.jobs.enqueue).toHaveBeenCalledTimes(1);
  });
  it("a routine edit or cancellation during observation wins the claim", async () => {
    const f=fixture("completed");
    f.execute.mockImplementation(async function* () {
      f.routine.updatedAt=new Date(Date.now()+1);
      yield {type:"stdout",data:JSON.stringify({...observation,status:"completed"})}; yield {type:"exit",code:0};
    });
    await createRunExecutor(f.deps).wakeRoutine("routine",f.due.toISOString());
    expect(f.runCreate).not.toHaveBeenCalled();
  });
  it("queue failure leaves one durable continuation, not a re-armed watcher", async () => {
    const f=fixture("completed"), executor=createRunExecutor(f.deps);
    f.deps.jobs.enqueue.mockRejectedValue(new Error("queue unavailable"));
    await expect(executor.wakeRoutine("routine",f.due.toISOString())).rejects.toThrow(/queue/);
    expect(f.routine.active).toBe(false); expect(f.runCreate).toHaveBeenCalledTimes(1);
    await executor.wakeRoutine("routine",f.due.toISOString());
    expect(f.runCreate).toHaveBeenCalledTimes(1);
    expect(f.db.run.deleteMany).not.toHaveBeenCalled();
  });
});
