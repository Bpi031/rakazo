import type { SandboxProvider } from "@rakazo/adapter-kit";
import { callIdFromClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { resolveCheckpointSegments } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import type { CheckpointFileManifest } from "./checkpoints/checkpoint-files.js";
import { CheckpointService } from "./checkpoints/checkpoint-service.js";

const stopped = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./checkpoints/checkpoint-processes.js", () => ({
  stopCheckpointWriters: stopped,
  assertCheckpointWritersIdle: vi.fn(async () => undefined),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimCheckpointWorkspace: vi.fn(async () => undefined),
  releaseCheckpointWorkspace: vi.fn(async () => undefined),
  withCheckpointRestoreLock: vi.fn(async (_db, _computerId, operation) => operation()),
}));
const actor = {
  userId: "user",
  spaceId: "space",
  email: "test@example.invalid",
  isDeploymentOwner: false,
};
const copy = <T>(value: T): T => structuredClone(value);
beforeEach(() => stopped.mockReset().mockResolvedValue(undefined));

type FixtureMessage = {
  id: string;
  seq: number;
  branchId: string;
  role: string;
  createdAt: Date;
  blocks: { kind: "text"; text: string }[];
  authorUserId?: string;
  runId?: string;
  clientNonce?: string;
};
type FixtureBranch = {
  id: string;
  threadId: string;
  parentBranchId: string | null;
  parentCutoffMessageSeq: number | null;
  parentCutoffEventSeq: number | null;
};
type FixtureCheckpoint = {
  id: string;
  threadId: string;
  botId: string;
  branchId: string;
  workspaceKey?: string | null;
  kind: string;
  createdAt: Date;
  businessState: { transcript: FixtureMessage[] };
};
type FixtureAudit = {
  id: string;
  createdAt: Date;
  branchId?: string;
  status: string;
  rescueCheckpointId?: string;
  details: { rescueReused?: boolean; error?: string };
};
type FixtureArtifact = {
  id: string;
  checkpointHidden: boolean;
  groupId?: string | null;
  hash?: string;
  storageKey?: string;
};
type FixtureRun = { id: string; taskId: string; status: string; trigger: string };
type WorkspaceWhere = {
  workspaceKey?: string | null;
  OR?: Array<{ workspaceKey?: string | null }>;
};
type Binding = { policy: string; selection: null };
type Builder = {
  where: WorkspaceWhere & { id?: string; botId?: string; threadId?: string; branchId?: string };
  orderBy?: unknown;
};
type FixtureQuery = {
  where: {
    id?: { in: string[] };
    status?: { in: string[] };
    groupId?: string | null;
    checkpointHidden?: boolean;
  };
  data: Record<string, unknown>;
};
type FixtureFiles = {
  version: 1;
  digest: string;
  entries: Extract<CheckpointFileManifest["entries"][number], { type: "file" }>[];
};

function fixture() {
  let serial = 0;
  let state = {
    thread: {
      id: "thread",
      botId: "bot",
      spaceId: "space",
      userId: "user",
      activeBranchId: "initial",
      checkpointGeneration: 0,
      checkpointBlocked: false,
      historyCompactionGeneration: 0,
      historyCompactionSummary: null as string | null,
      historyCompactedUpToSeq: null as number | null,
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
    ] as FixtureBranch[],
    bot: { id: "bot", instructions: "clean instructions", instructionHistory: [] },
    checkpoints: [] as FixtureCheckpoint[],
    audits: [] as FixtureAudit[],
    runs: [] as FixtureRun[],
    routines: [] as { active: boolean }[],
    artifacts: [
      { id: "input", hash: "input-hash", storageKey: "input", checkpointHidden: false },
    ] as FixtureArtifact[],
    messages: [
      {
        id: "m0",
        seq: 0,
        branchId: "initial",
        role: "user",
        createdAt: new Date(),
        blocks: [{ kind: "text", text: "clean inputs" }],
      },
    ] as FixtureMessage[],
  };
  let files: FixtureFiles = {
    version: 1,
    digest: "a".repeat(64),
    entries: [{ type: "file", path: "policy.rost", sha256: "a".repeat(64), mode: 384, size: 1 }],
  };
  let binding: Binding = { policy: "policy A", selection: null };
  let workspaceKey = "a".repeat(64);
  const matchesWorkspace = (row: FixtureCheckpoint, where: WorkspaceWhere) =>
    (where.workspaceKey === undefined || (row.workspaceKey ?? null) === where.workspaceKey) &&
    (!where.OR || where.OR.some((item) => (row.workspaceKey ?? null) === item.workspaceKey));
  const assign = <Row extends object>(row: Row, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        const previous: unknown = Reflect.get(row, key);
        if (
          typeof value.increment !== "number" ||
          (previous != null && typeof previous !== "number")
        )
          throw new Error("Invalid test counter update");
        Reflect.set(row, key, (previous ?? 0) + value.increment);
      } else Reflect.set(row, key, value);
    }
    return copy(row);
  };
  const tables = {
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
      findFirst: vi.fn(async ({ where }: Builder) =>
        copy(
          [...state.checkpoints]
            .reverse()
            .find(
              (row) =>
                (!where.id || row.id === where.id) &&
                (!where.botId || row.botId === where.botId) &&
                (!where.threadId || row.threadId === where.threadId) &&
                (!where.branchId || row.branchId === where.branchId) &&
                matchesWorkspace(row, where),
            ) ?? null,
        ),
      ),
      create: vi.fn(async ({ data }: { data: Omit<FixtureCheckpoint, "id" | "createdAt"> }) => {
        const row = { ...copy(data), id: `cp${++serial}`, createdAt: new Date() };
        state.checkpoints.push(row);
        return copy(row);
      }),
      findFirstOrThrow: vi.fn(async ({ where }) =>
        copy(state.checkpoints.find((row) => row.id === where.id)),
      ),
      findMany: vi.fn(async ({ orderBy, where }: Builder) => {
        const rows = state.checkpoints.filter((row) => matchesWorkspace(row, where));
        return copy(Array.isArray(orderBy) ? rows.reverse() : rows);
      }),
    },
    conversationBranch: {
      create: vi.fn(async ({ data }: { data: Omit<FixtureBranch, "id"> }) => {
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
            (row) =>
              (where.checkpointHidden === undefined ||
                row.checkpointHidden === where.checkpointHidden) &&
              (!where.id || where.id.in.includes(row.id)) &&
              (where.groupId !== null || row.groupId === null || row.groupId === undefined),
          ),
        ),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        const matching = state.artifacts.filter(
          (row) =>
            (!where.id || where.id.in.includes(row.id)) &&
            (where.groupId !== null || row.groupId === null || row.groupId === undefined),
        );
        matching.forEach((row) => {
          assign(row, data);
        });
        return { count: matching.length };
      }),
    },
    run: {
      count: vi.fn(async () => state.runs.filter((row) => row.status === "running").length),
      findMany: vi.fn(async ({ where }) =>
        copy(
          state.runs.filter(
            (row) =>
              (!where.id || where.id.in.includes(row.id)) &&
              (!where.status || where.status.in.includes(row.status)),
          ),
        ),
      ),
      findUniqueOrThrow: vi.fn(async () => copy(state.runs[0])),
      updateMany: vi.fn(async ({ data }) => {
        state.runs.forEach((row) => {
          assign(row, data);
        });
        return { count: state.runs.length };
      }),
      updateManyAndReturn: vi.fn(async ({ where, data }: FixtureQuery) =>
        state.runs
          .filter((row) => where.id?.in.includes(row.id) && where.status?.in.includes(row.status))
          .map((row) => assign(row, data)),
      ),
    },
    externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    task: { updateMany: vi.fn(async () => ({ count: 0 })) },
    computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 0 })) },
    computer: { updateMany: vi.fn(async () => ({ count: 0 })) },
    attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
    routine: {
      count: vi.fn(async () => 0),
      updateMany: vi.fn(async ({ data }) => {
        state.routines.forEach((row) => {
          assign(row, data);
        });
        return { count: state.routines.length };
      }),
    },
    rollbackAuditLog: {
      create: vi.fn(async ({ data }: { data: Omit<FixtureAudit, "id" | "createdAt"> }) => {
        const row = { ...copy(data), id: `audit${++serial}`, createdAt: new Date() };
        state.audits.push(row);
        return row;
      }),
      findMany: vi.fn(async () => copy(state.audits)),
      findFirst: vi.fn(async ({ where }) =>
        copy(
          state.audits
            .filter(
              (row) =>
                row.status === "completed" && (!where.branchId || row.branchId === where.branchId),
            )
            .at(-1) ?? null,
        ),
      ),
    },
    bot: {
      findFirst: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async () => copy(state.bot)),
      update: vi.fn(async ({ data }) => assign(state.bot, data)),
    },
    message: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            runId?: { in: string[] };
            role?: string;
            OR?: Array<{ branchId: string; seq?: { lte: number } }>;
          };
        }) =>
          copy(
            state.messages.filter(
              (message) =>
                (!where.runId ||
                  (message.runId !== undefined && where.runId.in.includes(message.runId))) &&
                (!where.role || where.role === message.role) &&
                (!where.OR ||
                  where.OR.some(
                    (segment) =>
                      segment.branchId === message.branchId &&
                      (!segment.seq || message.seq <= segment.seq.lte),
                  )),
            ),
          ),
      ),
      createMany: vi.fn(async ({ data }: { data: FixtureMessage[] }) => {
        state.messages.push(...copy(data));
        return { count: data.length };
      }),
    },
  };
  type FixtureClient = typeof tables & {
    $transaction: <Result>(callback: (client: FixtureClient) => Promise<Result>) => Promise<Result>;
  };
  const db: FixtureClient = {
    ...tables,
    $transaction: async (callback) => {
      const before = copy(state);
      try {
        return await callback(db);
      } catch (error) {
        state = before;
        throw error;
      }
    },
  };
  const service = new CheckpointService({
    prisma: db as unknown as PrismaClient,
    sandbox: {} as SandboxProvider,
    dataDir: "unused-test-directory",
  });
  const owned = vi.fn(async () => ({
    thread: copy(state.thread),
    computer: { id: "computer" },
    computerId: "computer",
    workspaceKey,
    scope: "dedicated" as const,
  }));
  const fileStore = {
    capture: vi.fn(async () => copy(files)),
    restore: vi.fn(
      async (_actor: typeof actor, _bot: string, _computer: unknown, manifest: FixtureFiles) => {
        files = copy(manifest);
      },
    ),
  };
  const priorities = {
    captureCheckpointBinding: vi.fn(async () => copy(binding)),
    restoreCheckpointBinding: vi.fn(async (_actor: typeof actor, _bot: string, value: Binding) => {
      binding = copy(value);
    }),
  };
  Object.assign(service, { owned, files: fileStore, priorities });
  return {
    service,
    owned,
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
    replaceWorkspace() {
      workspaceKey = "b".repeat(64);
    },
    change() {
      files = {
        ...files,
        digest: "b".repeat(64),
        entries: [
          { ...files.entries[0]!, sha256: "b".repeat(64) },
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
        .filter((message) =>
          segments.some(
            (segment) =>
              segment.branchId === message.branchId &&
              (segment.messageSeq === null || message.seq <= segment.messageSeq),
          ),
        )
        .map((message) => message.blocks[0]!.text);
    },
    save(label?: string) {
      return service.create(actor, {
        botId: "bot",
        expectedGeneration: state.thread.checkpointGeneration,
        label,
      });
    },
    async restore(id: string) {
      return service.rollback(actor, {
        botId: "bot",
        checkpointId: id,
        expectedGeneration: state.thread.checkpointGeneration,
        expectedRevision: (await service.status(actor, "bot")).revision,
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
  expect(f.state.artifacts.filter((row) => !row.checkpointHidden).map((row) => row.id)).toEqual([
    "input",
  ]);
  expect(f.visible()).toEqual(["clean inputs"]);
});

it("captures its own files without borrowing another Bot's checkpoint", async () => {
  const f = fixture();
  await f.save();
  Object.assign(f.state.checkpoints[0]!, {
    botId: "other-bot",
    threadId: "other-thread",
    branchId: "other-branch",
  });
  const saved = await f.save();
  expect(f.fileStore.capture).toHaveBeenLastCalledWith(
    actor,
    "bot",
    { id: "computer" },
    "dedicated",
  );
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
  Object.assign(f.state.messages[0]!, {
    authorUserId: actor.userId,
    runId: "original-run",
    clientNonce: "call:consultation:original",
  });
  const a = await f.save();
  expect((await f.restore(a.id)).ok).toBe(true);
  const restored = f.state.messages.at(-1)!;
  expect(restored.authorUserId).toBe(actor.userId);
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
  expect(f.state.artifacts.find((row) => row.id === "group-output")?.checkpointHidden).toBe(false);
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
  expect(f.state.runs[0]!.status).toBe("cancelled");
  expect(f.state.routines[0]!.active).toBe(false);
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
  expect(f.state.audits.at(-1)!.rescueCheckpointId).toBe(a.id);
  expect(f.state.audits.at(-1)!.details.rescueReused).toBe(true);
  // A prompt-only change must still be preserved, even with identical files.
  f.message("new instruction");
  await f.restore(a.id);
  expect(f.state.checkpoints).toHaveLength(count + 1);
  expect(f.state.checkpoints.at(-1)!.businessState.transcript.at(-1)!.blocks[0]!.text).toBe(
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
    promptCreatedAt: f.state.messages.at(-1)!.createdAt.toISOString(),
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

it("does not let an identical snapshot from a replaced workspace hide the valid one", async () => {
  const f = fixture();
  const previous = await f.save("Old computer");
  const ready = await f.service.status(actor, "bot");
  f.replaceWorkspace();
  const replaced = await f.service.status(actor, "bot");
  expect(replaced.generation).toBe(ready.generation);
  expect(replaced.revision).not.toBe(ready.revision);
  expect((await f.service.list(actor, "bot")).checkpoints).toEqual([]);
  const current = await f.save("Replacement computer");
  const view = await f.service.list(actor, "bot");
  expect(view.currentCheckpointId).toBe(current.id);
  expect(view.checkpoints).toMatchObject([{ id: current.id, parentCheckpointId: null }]);
  expect(view.revision).toBe((await f.service.status(actor, "bot")).revision);
  await expect(f.restore(previous.id)).rejects.toThrow("different workspace");
  await expect(f.restore(current.id)).resolves.toMatchObject({ ok: true });
  expect(f.state.checkpoints.some((row) => row.id === previous.id)).toBe(true);
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

it("shows an explicit save as manual without moving its existing automatic node", async () => {
  const f = fixture();
  const original = await f.save();
  f.state.checkpoints[0]!.kind = "auto_turn_boundary";
  const saved = await f.save();
  const view = await f.service.list(actor, "bot");
  expect(view.currentCheckpointId).toBe(original.id);
  expect(view.checkpoints).toMatchObject([
    {
      id: original.id,
      kind: "manual",
      label: null,
      createdAt: original.createdAt.toISOString(),
      parentCheckpointId: null,
    },
  ]);
  expect(saved.id).not.toBe(original.id);
  expect(f.state.checkpoints[0]!.kind).toBe("auto_turn_boundary");
});

it("keeps historical turn checkpoints available to restore", async () => {
  const f = fixture();
  const original = await f.save();
  f.state.checkpoints[0]!.kind = "auto_turn_boundary";
  expect((await f.service.list(actor, "bot")).checkpoints).toMatchObject([
    { id: original.id, kind: "auto_turn_boundary" },
  ]);
  f.change();
  await expect(f.restore(original.id)).resolves.toMatchObject({ ok: true });
  expect(f.files).toEqual(original.fileManifest);
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
      f.files.entries[0]!.sha256 = "d".repeat(64);
    }
    if (change === "binding") f.binding.policy = "changed binding";
    if (change === "artifact")
      f.state.artifacts.push({ id: "new artifact", checkpointHidden: false });
    if (change === "instructions") f.state.bot.instructions = "changed instructions";
    if (change === "answer") f.state.messages.at(-1)!.blocks[0]!.text = "edited answer";
    expect((await f.restore(a.id)).ok).toBe(true);
    expect(f.state.checkpoints).toHaveLength(count + 1);
    expect(f.state.audits.at(-1)!.details.rescueReused).toBe(false);
  },
);

it("A4 resets the abandoned summary and native-session generation", async () => {
  const f = fixture(),
    a = await f.save();
  f.message("wrong unique rule");
  f.state.thread.historyCompactionSummary = "wrong unique rule";
  f.state.thread.historyCompactedUpToSeq = 1;
  f.state.bot.instructions = "wrong unique rule";
  f.state.messages[0]!.blocks[0]!.text = "mutated after checkpoint";
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
      (row) => row.id === audit.audits[0]!.rescueCheckpointId && row.kind === "auto_pre_rollback",
    ),
  ).toBe(true);
});

it("reads retained research snapshots and hidden artifact metadata without a live workspace", async () => {
  const f = fixture();
  const checkpoint = await f.save();
  f.state.artifacts[0]!.checkpointHidden = true;
  f.state.messages = [];
  const owned = f.owned.mockRejectedValue(new Error("Bot deleted"));
  owned.mockClear();

  const audit = await f.service.audit(actor, "bot");

  expect(owned).not.toHaveBeenCalled();
  expect(audit.checkpoints.map((row) => row.id)).toEqual([checkpoint.id]);
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
  expect(f.state.checkpoints.some((row) => row.kind === "auto_pre_rollback")).toBe(true);
  expect(f.state.audits.at(-1)!.status).toBe("failed");
  await expect(f.save()).rejects.toThrow(/refresh/);
});

it.each(["missing", "changed"])(
  "rejects a restore with a %s saved attachment before stopping jobs or replacing files",
  async (damage) => {
    const f = fixture();
    const original = await f.save();
    f.change();
    const current = copy(f.files);
    f.state.runs.push({ id: "existing-run", taskId: "task", status: "running", trigger: "user" });
    if (damage === "missing") f.state.artifacts = [];
    else f.state.artifacts[0]!.hash = "different artifact bytes";
    await expect(f.restore(original.id)).rejects.toThrow(
      "Saved checkpoint attachments are unavailable",
    );
    expect(f.files).toEqual(current);
    expect(f.fileStore.restore).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    expect(f.state.runs[0]!.status).toBe("running");
    expect(f.state.thread).toMatchObject({ checkpointGeneration: 0, checkpointBlocked: false });
  },
);

it("records SQL failures on a fresh transaction while preserving the rescue", async () => {
  const f = fixture(),
    a = await f.save();
  f.change();
  f.db.conversationBranch.create.mockRejectedValueOnce(new Error("database unavailable"));
  expect((await f.restore(a.id)).ok).toBe(false);
  expect(f.state.thread.checkpointBlocked).toBe(true);
  expect(f.state.checkpoints.some((row) => row.kind === "auto_pre_rollback")).toBe(true);
  expect(f.state.audits.at(-1)!.details.error).toBe("database unavailable");
});
