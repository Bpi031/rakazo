import { callIdFromClientNonce } from "@rakazo/core";
import { resolveCheckpointSegments } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import { CheckpointService } from "./checkpoint-service.js";

const stopped = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./checkpoint-processes.js", () => ({
  stopCheckpointWriters: stopped,
  assertCheckpointWritersIdle: vi.fn(async () => undefined),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimCheckpointWorkspace: vi.fn(async () => undefined),
  releaseCheckpointWorkspace: vi.fn(async () => undefined),
}));
const actor = {
  userId: "user",
  spaceId: "space",
  email: "test@example.invalid",
  isDeploymentOwner: false,
};
const copy = <T>(value: T): T => structuredClone(value);
beforeEach(() => stopped.mockReset().mockResolvedValue(undefined));

function fixture() {
  let serial = 0;
  let state: any = {
    thread: {
      id: "thread",
      botId: "bot",
      spaceId: "space",
      userId: "user",
      activeBranchId: "initial",
      checkpointGeneration: 0,
      checkpointBlocked: false,
      historyCompactionGeneration: 0,
      historyCompactionSummary: null,
      historyCompactedUpToSeq: null,
      nextMessageSeq: 1,
      nextEventSeq: 0,
    },
    branches: [
      {
        id: "initial",
        threadId: "thread",
        parentBranchId: null,
        parentCutoffMessageSeq: null,
        parentCutoffEventSeq: null,
      },
    ],
    bot: { instructions: "clean instructions", pendingInstructionsRunId: null },
    checkpoints: [],
    audits: [],
    runs: [],
    routines: [],
    artifacts: [{ id: "input", hash: "input-hash", storageKey: "input", checkpointHidden: false }],
    messages: [
      {
        id: "m0",
        seq: 0,
        branchId: "initial",
        role: "user",
        createdAt: new Date(),
        blocks: [{ kind: "text", text: "clean inputs" }],
      },
    ],
  };
  let files: any = {
    version: 1,
    digest: "a".repeat(64),
    entries: [{ type: "file", path: "policy.rost", sha256: "a".repeat(64), mode: 384, size: 1 }],
  };
  let binding: any = { policy: "policy A", selection: null };
  const assign = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data))
      row[key] =
        value && typeof value === "object" && "increment" in value
          ? (row[key] ?? 0) + (value as any).increment
          : value;
    return copy(row);
  };
  const db: any = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    thread: {
      findUnique: vi.fn(async () => copy(state.thread)),
      findUniqueOrThrow: vi.fn(async () => copy(state.thread)),
      findFirstOrThrow: vi.fn(async () => copy(state.thread)),
      update: vi.fn(async ({ data }) => assign(state.thread, data)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.checkpointGeneration !== undefined &&
          where.checkpointGeneration !== state.thread.checkpointGeneration
        )
          return { count: 0 };
        assign(state.thread, data);
        return { count: 1 };
      }),
    },
    checkpoint: {
      findFirst: vi.fn(async ({ where }) =>
        copy(
          [...state.checkpoints]
            .reverse()
            .find(
              (row: any) =>
                (!where.id || row.id === where.id) &&
                (!where.botId || row.botId === where.botId) &&
                (!where.threadId || row.threadId === where.threadId) &&
                (!where.branchId || row.branchId === where.branchId),
            ) ?? null,
        ),
      ),
      create: vi.fn(async ({ data }) => {
        const row = { ...copy(data), id: `cp${++serial}`, createdAt: new Date() };
        state.checkpoints.push(row);
        return copy(row);
      }),
      findFirstOrThrow: vi.fn(async ({ where }) =>
        copy(state.checkpoints.find((row: any) => row.id === where.id)),
      ),
      findMany: vi.fn(async ({ orderBy }) =>
        copy(Array.isArray(orderBy) ? [...state.checkpoints].reverse() : state.checkpoints),
      ),
    },
    conversationBranch: {
      create: vi.fn(async ({ data }) => {
        const row = { ...data, id: `branch${++serial}` };
        state.branches.push(row);
        return copy(row);
      }),
      findMany: vi.fn(async () => copy(state.branches)),
    },
    artifact: {
      findMany: vi.fn(async ({ where }) =>
        copy(
          state.artifacts.filter(
            (row: any) =>
              (where.checkpointHidden === undefined ||
                row.checkpointHidden === where.checkpointHidden) &&
              (!where.id || where.id.in.includes(row.id)) &&
              (where.groupId !== null || row.groupId === null || row.groupId === undefined),
          ),
        ),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        state.artifacts
          .filter(
            (row: any) =>
              (!where.id || where.id.in.includes(row.id)) &&
              (where.groupId !== null || row.groupId === null || row.groupId === undefined),
          )
          .forEach((row: any) => {
            assign(row, data);
          });
        return { count: 1 };
      }),
    },
    run: {
      count: vi.fn(async () => state.runs.filter((row: any) => row.status === "running").length),
      findMany: vi.fn(async () => copy(state.runs.filter((row: any) => row.status === "running"))),
      findUniqueOrThrow: vi.fn(async () => copy(state.runs[0])),
      updateMany: vi.fn(async ({ data }) => {
        state.runs.forEach((row: any) => {
          assign(row, data);
        });
        return { count: state.runs.length };
      }),
    },
    task: { updateMany: vi.fn(async () => ({ count: 0 })) },
    computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 0 })) },
    computer: { updateMany: vi.fn(async () => ({ count: 0 })) },
    attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
    routine: {
      count: vi.fn(async () => 0),
      updateMany: vi.fn(async ({ data }) => {
        state.routines.forEach((row: any) => {
          assign(row, data);
        });
        return { count: state.routines.length };
      }),
    },
    rollbackAuditLog: {
      create: vi.fn(async ({ data }) => {
        const row = { ...copy(data), id: `audit${++serial}`, createdAt: new Date() };
        state.audits.push(row);
        return row;
      }),
      findMany: vi.fn(async () => copy(state.audits)),
      findFirst: vi.fn(async ({ where }) =>
        copy(
          state.audits
            .filter(
              (row: any) =>
                row.status === "completed" && (!where.branchId || row.branchId === where.branchId),
            )
            .at(-1) ?? null,
        ),
      ),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => copy(state.bot)),
      update: vi.fn(async ({ data }) => assign(state.bot, data)),
    },
    message: {
      findMany: vi.fn(async ({ where }) =>
        copy(
          state.messages.filter(
            (message: any) =>
              !where.OR ||
              where.OR.some(
                (segment: any) =>
                  segment.branchId === message.branchId &&
                  (!segment.seq || message.seq <= segment.seq.lte),
              ),
          ),
        ),
      ),
      createMany: vi.fn(async ({ data }) => {
        state.messages.push(...copy(data));
        return { count: data.length };
      }),
    },
  };
  db.$transaction = async (callback: any) => {
    const before = copy(state);
    try {
      return await callback(db);
    } catch (error) {
      state = before;
      throw error;
    }
  };
  const service = new CheckpointService({
    prisma: db,
    sandbox: {} as any,
    dataDir: "unused-test-directory",
  });
  vi.spyOn(service as any, "owned").mockImplementation(async () => ({
    thread: copy(state.thread),
    computer: { id: "computer" },
    computerId: "computer",
    workspaceKey: "a".repeat(64),
    scope: "dedicated",
  }));
  const fileStore = {
    capture: vi.fn(async () => copy(files)),
    restore: vi.fn(async (_actor, _bot, _computer, manifest) => {
      files = copy(manifest);
    }),
  };
  (service as any).files = fileStore;
  (service as any).priorities = {
    captureCheckpointBinding: vi.fn(async () => copy(binding)),
    restoreCheckpointBinding: vi.fn(async (_actor, _bot, value) => {
      binding = copy(value);
    }),
  };
  return {
    service,
    db,
    fileStore,
    get state() {
      return state;
    },
    get files() {
      return files;
    },
    get binding() {
      return binding;
    },
    change() {
      files = {
        ...files,
        digest: "b".repeat(64),
        entries: [
          { ...files.entries[0], sha256: "b".repeat(64) },
          { type: "file", path: "wrong.xlsx", sha256: "c".repeat(64), mode: 384, size: 2 },
        ],
      };
      binding = { policy: "wrong policy", selection: null };
    },
    message(text: string) {
      state.messages.push({
        id: `m${state.thread.nextMessageSeq}`,
        seq: state.thread.nextMessageSeq++,
        branchId: state.thread.activeBranchId,
        role: "user",
        createdAt: new Date(),
        blocks: [{ kind: "text", text }],
      });
    },
    visible() {
      const segments = resolveCheckpointSegments(state.branches, state.thread.activeBranchId);
      return state.messages
        .filter((message: any) =>
          segments.some(
            (segment) =>
              segment.branchId === message.branchId &&
              (segment.messageSeq === null || message.seq <= segment.messageSeq),
          ),
        )
        .map((message: any) => message.blocks[0].text);
    },
    save(label?: string) {
      return service.create(actor, {
        botId: "bot",
        expectedGeneration: state.thread.checkpointGeneration,
        label,
      });
    },
    restore(id: string) {
      return service.rollback(actor, {
        botId: "bot",
        checkpointId: id,
        expectedGeneration: state.thread.checkpointGeneration,
      });
    },
  };
}

it("A1 restores files, rule binding and artifact visibility together", async () => {
  const f = fixture(),
    a = await f.save();
  const files = copy(f.files),
    binding = copy(f.binding);
  f.change();
  f.message("failed branch");
  f.state.artifacts.push({ id: "wrong", checkpointHidden: false });
  expect((await f.restore(a.id)).ok).toBe(true);
  expect(f.files).toEqual(files);
  expect(f.binding).toEqual(binding);
  expect(
    f.state.artifacts.filter((row: any) => !row.checkpointHidden).map((row: any) => row.id),
  ).toEqual(["input"]);
  expect(f.visible()).toEqual(["clean inputs"]);
});

it("captures its own files without borrowing another Bot's checkpoint", async () => {
  const f = fixture();
  await f.save();
  Object.assign(f.state.checkpoints[0], {
    botId: "other-bot", threadId: "other-thread", branchId: "other-branch",
  });
  const saved = await f.save();
  expect(f.fileStore.capture).toHaveBeenLastCalledWith(actor, "bot", { id: "computer" }, "dedicated");
  expect(saved.businessState).not.toHaveProperty("fileReuseSourceCheckpointId");
  expect(saved.businessState).toMatchObject({ parentCheckpointId: null });
});

it("A2 repeated forks retain history without exposing sibling branches", async () => {
  const f = fixture(),
    a = await f.save();
  f.message("branch B");
  const b = await f.save();
  await f.restore(a.id);
  f.message("branch C");
  expect(f.visible()).toEqual(["clean inputs", "branch C"]);
  await f.restore(b.id);
  expect(f.visible()).toEqual(["clean inputs", "branch B"]);
  expect(f.state.messages).toHaveLength(6);
  expect(f.state.thread.nextMessageSeq).toBe(6);
});

it("restores message origin for background filtering and voice grouping without reusing retry nonces", async () => {
  const f = fixture();
  Object.assign(f.state.messages[0], {
    runId: "original-run",
    clientNonce: "call:consultation:original",
  });
  const a = await f.save();
  expect((await f.restore(a.id)).ok).toBe(true);
  const restored = f.state.messages.at(-1);
  expect(restored.runId).toBe("original-run");
  expect(callIdFromClientNonce(restored.clientNonce)).toBe("consultation");
  expect(restored.clientNonce).not.toBe("call:consultation:original");
  // Nonce regeneration must not look like a meaningful change on another jump.
  const before = f.state.checkpoints.length;
  await f.restore(a.id);
  expect(f.state.checkpoints).toHaveLength(before);
});

it("does not capture or hide another group conversation's artifacts", async () => {
  const f = fixture();
  const a = await f.save();
  f.state.artifacts.push({ id: "group-output", groupId: "group", checkpointHidden: false });
  expect((await f.restore(a.id)).ok).toBe(true);
  expect(f.state.artifacts.find((row: any) => row.id === "group-output").checkpointHidden).toBe(
    false,
  );
  expect(f.state.checkpoints).toHaveLength(1);
});

it("A3 restores the rescue checkpoint from history without restarting tasks", async () => {
  const f = fixture(),
    a = await f.save();
  f.change();
  f.message("before rollback");
  const before = copy(f.files);
  f.state.runs.push({ id: "run", taskId: "task", status: "running", trigger: "user" });
  f.state.routines.push({ active: true });
  const rollback = await f.restore(a.id);
  if (!rollback.ok) throw new Error("Rollback failed");
  expect((await f.restore(rollback.rescueCheckpointId)).ok).toBe(true);
  expect(f.files).toEqual(before);
  expect(f.visible()).toEqual(["clean inputs", "before rollback"]);
  expect(f.state.runs[0].status).toBe("cancelled");
  expect(f.state.routines[0].active).toBe(false);
});

it("reuses the restored state on unchanged jumps and keeps real changes", async () => {
  const f = fixture();
  const a = await f.save();
  f.message("branch B");
  const b = await f.save();
  await f.restore(a.id);
  const count = f.state.checkpoints.length;
  await f.restore(b.id);
  expect(f.state.checkpoints).toHaveLength(count);
  expect(f.state.audits.at(-1).rescueCheckpointId).toBe(a.id);
  expect(f.state.audits.at(-1).details.rescueReused).toBe(true);
  // A prompt-only change must still be preserved, even with identical files.
  f.message("new instruction");
  await f.restore(a.id);
  expect(f.state.checkpoints).toHaveLength(count + 1);
  expect(f.state.checkpoints.at(-1).businessState.transcript.at(-1).blocks[0].text).toBe(
    "new instruction",
  );
});

it("returns branch ancestry and the last user prompt timestamp", async () => {
  const f = fixture();
  const a = await f.save();
  await f.restore(a.id);
  const branch = f.state.thread.activeBranchId;
  f.message("new branch prompt");
  const b = await f.save();
  const view = await f.service.list(actor, "bot");
  expect(view.currentCheckpointId).toBe(b.id);
  expect(view.checkpoints.find((row) => row.id === b.id)).toMatchObject({
    parentCheckpointId: a.id,
    promptPreview: "new branch prompt",
    promptCreatedAt: f.state.messages.at(-1).createdAt.toISOString(),
  });
  expect(view.branches.find((row) => row.id === branch)?.parentCheckpointId).toBe(a.id);
  expect(view).not.toHaveProperty("undoCheckpointId");
});

it("collapses duplicate historical snapshots into one visible node while retaining audit data", async () => {
  const f = fixture();
  const a = await f.save();
  const duplicate = await f.save();
  await f.restore(duplicate.id);
  const view = await f.service.list(actor, "bot");
  expect(view.checkpoints.map((node) => node.id)).toEqual([a.id]);
  expect(view.currentCheckpointId).toBe(a.id);
  expect(view.checkpoints[0]!.parentCheckpointId).toBeNull();
  expect(f.state.checkpoints).toHaveLength(2);
  expect(f.state.audits).toHaveLength(1);
});

it("shows the latest optional name when equivalent checkpoints are merged", async () => {
  const f = fixture();
  const original = await f.save();
  const named = await f.save("Reviewed inputs");
  const view = await f.service.list(actor, "bot");
  expect(view.checkpoints).toHaveLength(1);
  expect(view.checkpoints[0]).toMatchObject({
    id: original.id,
    label: "Reviewed inputs",
    parentCheckpointId: null,
  });
  expect(named.id).not.toBe(original.id);
});

it("keeps the tree acyclic when an earlier state is named again after a fork", async () => {
  const f = fixture();
  const a = await f.save();
  f.message("alternative branch");
  const b = await f.save();
  await f.restore(a.id);
  await f.save("Reviewed again");
  const view = await f.service.list(actor, "bot");
  expect(view.checkpoints).toHaveLength(2);
  expect(view.checkpoints.find((node) => node.id === a.id)).toMatchObject({
    label: "Reviewed again",
    parentCheckpointId: null,
  });
  expect(view.checkpoints.find((node) => node.id === b.id)?.parentCheckpointId).toBe(a.id);
});

it("polls status using checkpoint identity only and changes revision after saving", async () => {
  const f = fixture();
  const before = await f.service.status(actor, "bot");
  await f.save();
  f.db.checkpoint.findMany.mockClear();
  const after = await f.service.status(actor, "bot");
  expect(after.revision).not.toBe(before.revision);
  expect(f.db.checkpoint.findMany).not.toHaveBeenCalled();
  expect(f.db.rollbackAuditLog.findMany).not.toHaveBeenCalled();
  expect(f.db.checkpoint.findFirst).toHaveBeenLastCalledWith(
    expect.objectContaining({ select: { id: true } }),
  );
  expect((await f.service.list(actor, "bot")).revision).toBe(after.revision);
});

it.each(["file", "binding", "artifact", "instructions", "answer"])(
  "preserves %s changes before switching checkpoints",
  async (change) => {
    const f = fixture();
    const a = await f.save();
    await f.restore(a.id);
    const count = f.state.checkpoints.length;
    if (change === "file") {
      f.files.digest = "d".repeat(64);
      f.files.entries[0].sha256 = "d".repeat(64);
    }
    if (change === "binding") f.binding.policy = "changed binding";
    if (change === "artifact")
      f.state.artifacts.push({ id: "new artifact", checkpointHidden: false });
    if (change === "instructions") f.state.bot.instructions = "changed instructions";
    if (change === "answer") f.state.messages.at(-1).blocks[0].text = "edited answer";
    expect((await f.restore(a.id)).ok).toBe(true);
    expect(f.state.checkpoints).toHaveLength(count + 1);
    expect(f.state.audits.at(-1).details.rescueReused).toBe(false);
  },
);

it("A4 resets the abandoned summary and native-session generation", async () => {
  const f = fixture(),
    a = await f.save();
  f.message("wrong unique rule");
  f.state.thread.historyCompactionSummary = "wrong unique rule";
  f.state.thread.historyCompactedUpToSeq = 1;
  f.state.bot.instructions = "wrong unique rule";
  f.state.messages[0].blocks[0].text = "mutated after checkpoint";
  await f.restore(a.id);
  expect(f.state.thread.historyCompactionSummary).toBeNull();
  expect(f.state.thread.historyCompactedUpToSeq).toBeNull();
  expect(f.state.thread.historyCompactionGeneration).toBe(1);
  expect(f.visible().join(" ")).not.toContain("wrong unique rule");
  expect(f.visible()).toEqual(["clean inputs"]);
  expect(f.state.bot.instructions).toBe("clean instructions");
});

it("A13 exports rescue references, branch history, file changes and task observations", async () => {
  const f = fixture(),
    a = await f.save();
  f.change();
  f.message("failed branch");
  await f.restore(a.id);
  const audit = await f.service.audit(actor, "bot");
  expect(audit.restoreMode).toBe("reconstructed");
  expect(audit.messages).toHaveLength(3);
  expect(audit.audits[0]).toMatchObject({
    status: "completed",
    toCheckpointId: a.id,
    generation: 1,
    details: { solveStarted: false, files: { removed: ["wrong.xlsx"], changed: ["policy.rost"] } },
  });
  expect(
    audit.checkpoints.some(
      (row: any) =>
        row.id === audit.audits[0]!.rescueCheckpointId && row.kind === "auto_pre_rollback",
    ),
  ).toBe(true);
});

it("reads retained research snapshots and hidden artifact metadata without a live workspace", async () => {
  const f = fixture();
  const checkpoint = await f.save();
  f.state.artifacts[0].checkpointHidden = true;
  f.state.messages = [];
  const owned = vi.mocked((f.service as any).owned).mockRejectedValue(new Error("Bot deleted"));
  owned.mockClear();

  const audit = await f.service.audit(actor, "bot");

  expect(owned).not.toHaveBeenCalled();
  expect(audit.checkpoints.map((row: any) => row.id)).toEqual([checkpoint.id]);
  expect(audit.checkpoints[0]!.businessState).toMatchObject({
    transcript: [{ blocks: [{ kind: "text", text: "clean inputs" }] }],
  });
  expect(audit.messages).toEqual([]);
  expect(audit.artifacts).toMatchObject([{ id: "input", checkpointHidden: true }]);
  expect(f.db.checkpoint.findMany).toHaveBeenLastCalledWith({
    where: { botId: "bot", spaceId: actor.spaceId, userId: actor.userId },
    orderBy: { createdAt: "asc" },
  });
  expect(f.db.artifact.findMany).toHaveBeenLastCalledWith({
    where: { id: { in: ["input"] }, spaceId: actor.spaceId, userId: actor.userId, groupId: null },
    orderBy: { createdAt: "asc" },
  });
});

it("rejects an unknown research archive instead of reading unscoped records", async () => {
  const f = fixture();
  f.db.bot.findFirst = vi.fn().mockResolvedValue(null);
  await expect(f.service.audit(actor, "unknown")).rejects.toThrow("Resource not found");
  expect(f.db.rollbackAuditLog.findMany).not.toHaveBeenCalled();
  expect(f.db.artifact.findMany).not.toHaveBeenCalled();
});

it("preserves the committed rescue and blocks further work when restore fails", async () => {
  const f = fixture(),
    a = await f.save();
  f.change();
  f.fileStore.restore.mockRejectedValue(new Error("file transfer failed"));
  expect((await f.restore(a.id)).ok).toBe(false);
  expect(f.state.thread.checkpointBlocked).toBe(true);
  expect(f.state.checkpoints.some((row: any) => row.kind === "auto_pre_rollback")).toBe(true);
  expect(f.state.audits.at(-1).status).toBe("failed");
  await expect(f.save()).rejects.toThrow(/refresh/);
});

it("records SQL failures on a fresh transaction while preserving the rescue", async () => {
  const f = fixture(),
    a = await f.save();
  f.change();
  f.db.conversationBranch.create.mockRejectedValueOnce(new Error("database unavailable"));
  expect((await f.restore(a.id)).ok).toBe(false);
  expect(f.state.thread.checkpointBlocked).toBe(true);
  expect(f.state.checkpoints.some((row: any) => row.kind === "auto_pre_rollback")).toBe(true);
  expect(f.state.audits.at(-1).details.error).toBe("database unavailable");
});
