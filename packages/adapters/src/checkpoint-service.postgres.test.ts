import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  assertRunCanWriteHistory,
  checkpointMessageWhere,
  checkpointRunFields,
  computerScopeKey,
  createDb,
  createThreadMessage,
  loadRunHistoryMessages,
  searchHistory,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalArtifactStore } from "./artifacts.js";
import type { CheckpointFileManifest } from "./checkpoint-files.js";
import { CheckpointService } from "./checkpoint-service.js";
import { destroyBot } from "./child-bots.js";
import { LocalAgentHomeStore } from "./home.js";

// Opt in with a dedicated, fully migrated disposable database. Never use DATABASE_URL.
const connection = process.env.CHECKPOINT_TEST_DATABASE_URL;
const enabled =
  connection && /^rakazo_checkpoint_[a-z0-9_]+$/.test(new URL(connection).pathname.slice(1));
const postgres = enabled ? describe.sequential : describe.skip;

postgres("checkpoint recovery with migrated PostgreSQL", () => {
  const scope = randomUUID();
  const actor: Actor = {
    userId: `user-${scope}`,
    spaceId: `space-${scope}`,
    email: "checkpoint@example.invalid",
    isDeploymentOwner: false,
  };
  const botId = `bot-${scope}`;
  const threadId = `thread-${scope}`;
  let prisma: PrismaClient;
  let disconnect: () => Promise<void>;
  let service: CheckpointService;
  let files: Record<string, string> = {};
  let binding: unknown = null;
  const saved = new Map<string, Record<string, string>>();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const manifest = (): CheckpointFileManifest => {
    const entries = Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({
        type: "file" as const,
        path,
        size: Buffer.byteLength(content),
        sha256: hash(content),
        mode: 0o600,
      }));
    const digest = hash(JSON.stringify(entries));
    saved.set(digest, { ...files });
    return { version: 1, entries, digest };
  };

  beforeAll(async () => {
    const db = createDb(connection!, { poolMax: 4 });
    prisma = db.prisma;
    disconnect = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: { id: scope, name: "Synthetic checkpoint", slug: scope, createdAt: new Date() },
    });
    await prisma.user.create({
      data: { id: actor.userId, name: "Synthetic", email: `${scope}@example.invalid` },
    });
    await prisma.space.create({
      data: { id: actor.spaceId, organizationId: scope, name: "Synthetic checkpoint" },
    });
    const computer = await prisma.computer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        scope: "dedicated",
        scopeKey: scope,
        homeKey: scope,
        kind: "fake",
        providerRef: scope,
        state: "running",
      },
    });
    await prisma.bot.create({
      data: {
        id: botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Synthetic",
        color: "blue",
        computerId: computer.id,
      },
    });
    await prisma.thread.create({
      data: { id: threadId, spaceId: actor.spaceId, userId: actor.userId, botId },
    });
    const sandbox = {
      execute: async function* () {
        yield { type: "stdout", data: "checkpoint-writers-stopped checkpoint-writers-idle" };
        yield { type: "exit", code: 0 };
      },
    } as unknown as SandboxProvider;
    service = new CheckpointService({
      prisma,
      sandbox,
      dataDir: ".unused-synthetic-checkpoint-data",
    });
    // Exercise real transactions and visibility, with deterministic external storage boundaries.
    Object.assign(service, {
      files: {
        capture: async () => manifest(),
        restore: async (
          _actor: unknown,
          _bot: unknown,
          _computer: unknown,
          target: CheckpointFileManifest,
        ) => {
          const copy = saved.get(target.digest);
          if (!copy) throw new Error("Missing synthetic blob");
          files = { ...copy };
        },
      },
      priorities: {
        captureCheckpointBinding: async () => binding,
        restoreCheckpointBinding: async (_actor: unknown, _bot: unknown, value: unknown) => {
          binding = value;
        },
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.rollbackAuditLog.deleteMany({ where: { threadId } });
    await prisma.checkpoint.deleteMany({ where: { threadId } });
    await prisma.conversationBranch.deleteMany({ where: { threadId } });
    await prisma.organization.delete({ where: { id: scope } });
    await prisma.user.delete({ where: { id: actor.userId } });
    await disconnect();
  });

  const say = (text: string) =>
    createThreadMessage(prisma, { threadId, role: "user", blocks: [{ kind: "text", text }] });
  const visible = async () =>
    (
      await prisma.message.findMany({
        where: await checkpointMessageWhere(prisma, threadId),
        orderBy: { seq: "asc" },
      })
    ).map((message) => (message.blocks as Array<{ text: string }>)[0]!.text);
  const artifact = (id: string) =>
    prisma.artifact.create({
      data: {
        id: `${id}-${scope}`,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        name: `${id}.xlsx`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 4,
        hash: hash(id),
        storageKey: id,
      },
    });

  it("restores files, rules and artifacts; branches repeatedly; rescue recovery keeps tasks stopped; exports audit", async () => {
    await prisma.bot.update({
      where: { id: botId },
      data: { instructions: "CLEAN_BOT_INSTRUCTIONS" },
    });
    const originalA = await say("CLEAN_A");
    files = {
      "input.xlsx": "original workbook",
      "policy.rost": "clean policy",
      "result.xlsx": "valid roster",
    };
    binding = { policy: "policy.rost", sourceSha256: hash("clean policy") };
    await artifact("artifact-a");
    const a = await service.create(actor, { botId, expectedGeneration: 0, label: "A" });

    await say("FAILURE_UNIQUE_B");
    files = {
      "input.xlsx": "changed workbook",
      "policy.rost": "wrong policy",
      "extra.py": "failed code",
    };
    binding = { policy: "policy.rost", sourceSha256: hash("wrong policy") };
    await artifact("artifact-b");
    const b = await service.create(actor, { botId, expectedGeneration: 0, label: "B" });
    // Existing card answers and stream finalization can mutate blocks after a checkpoint.
    await prisma.message.update({
      where: { id: originalA.id },
      data: { blocks: [{ kind: "text", text: "MUTATED_AFTER_SNAPSHOT" }] },
    });
    await prisma.thread.update({
      where: { id: threadId },
      data: { historyCompactionSummary: "FAILURE_UNIQUE_B", historyCompactedUpToSeq: 1 },
    });
    await prisma.bot.update({
      where: { id: botId },
      data: { instructions: "FAILED_BOT_INSTRUCTIONS" },
    });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
    const task = await prisma.task.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        threadId,
        userId: actor.userId,
        prompt: "solve",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        threadId,
        userId: actor.userId,
        taskId: task.id,
        status: "running",
        trigger: "routine",
        branchId: thread.activeBranchId,
        checkpointGeneration: 0,
      },
    });
    const routine = await prisma.routine.create({
      data: {
        spaceId: actor.spaceId,
        botId,
        threadId,
        userId: actor.userId,
        name: "Synthetic watch",
        prompt: "watch",
        crons: [],
        active: true,
        jobWatch: { synthetic: true },
      },
    });

    const restoredA = await service.rollback(actor, {
      botId,
      checkpointId: a.id,
      expectedGeneration: 0,
    });
    expect(restoredA.ok).toBe(true);
    expect(files).toEqual({
      "input.xlsx": "original workbook",
      "policy.rost": "clean policy",
      "result.xlsx": "valid roster",
    });
    expect(binding).toEqual({ policy: "policy.rost", sourceSha256: hash("clean policy") });
    expect(await visible()).toEqual(["CLEAN_A"]);
    expect(
      (await prisma.artifact.findMany({ where: { botId, checkpointHidden: false } })).map(
        (row) => row.storageKey,
      ),
    ).toEqual(["artifact-a"]);
    expect(
      (await prisma.thread.findUniqueOrThrow({ where: { id: threadId } })).historyCompactionSummary,
    ).toBeNull();
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).instructions).toBe(
      "CLEAN_BOT_INSTRUCTIONS",
    );
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "cancelled",
    );
    expect((await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } })).active).toBe(
      false,
    );
    await expect(prisma.$transaction((tx) => assertRunCanWriteHistory(tx, run.id))).rejects.toThrow(
      "Run cannot write",
    );
    expect(
      (await loadRunHistoryMessages(prisma, { id: run.id, threadId }, 30)).map(
        (message) => message.blocks,
      ),
    ).toEqual([[{ kind: "text", text: "CLEAN_A" }]]);
    expect(
      (await searchHistory(prisma, { ...actor, botId, threadId }, { query: "FAILURE_UNIQUE_B" }))
        .messages,
    ).toHaveLength(0);

    await say("ALTERNATIVE_C");
    files["policy.rost"] = "alternative policy";
    binding = { policy: "policy.rost", sourceSha256: hash("alternative policy") };
    await service.create(actor, { botId, expectedGeneration: 1, label: "C" });
    const restoredB = await service.rollback(actor, {
      botId,
      checkpointId: b.id,
      expectedGeneration: 1,
    });
    expect(restoredB.ok).toBe(true);
    expect(await visible()).toEqual(["CLEAN_A", "FAILURE_UNIQUE_B"]);
    expect(files["extra.py"]).toBe("failed code");
    if (!restoredB.ok) throw new Error("Missing rescue");
    expect(
      (
        await service.rollback(actor, {
          botId,
          checkpointId: restoredB.rescueCheckpointId,
          expectedGeneration: 2,
        })
      ).ok,
    ).toBe(true);
    expect(await service.list(actor, botId)).not.toHaveProperty("undoCheckpointId");
    expect(await visible()).toEqual(["CLEAN_A", "ALTERNATIVE_C"]);
    expect(files["policy.rost"]).toBe("alternative policy");
    expect(files["extra.py"]).toBeUndefined();
    expect(
      await prisma.run.count({ where: { threadId, status: { in: ["queued", "running"] } } }),
    ).toBe(0);
    expect(await prisma.message.count({ where: { threadId } })).toBeGreaterThan(3);
    expect(
      (await prisma.message.findUniqueOrThrow({ where: { id: originalA.id } })).blocks,
    ).toEqual([{ kind: "text", text: "MUTATED_AFTER_SNAPSHOT" }]);
    const audit = await service.audit(actor, botId);
    expect(audit.schema).toBe("rakazo/checkpoint-audit/v1");
    expect(audit.restoreMode).toBe("reconstructed");
    expect(audit.audits).toHaveLength(3);
    expect(audit.audits.every((row) => row.status === "completed" && row.rescueCheckpointId)).toBe(
      true,
    );
    expect(audit.messages.length).toBeGreaterThan(3);
    expect(audit.branches.length).toBe(4);
    expect(JSON.stringify(audit.audits)).toContain("rulesBefore");
    expect(JSON.stringify(audit.audits)).toContain("cancelledTasks");
  }, 30_000);

  it("restores immutable reply blocks and remaps their references to the cloned prefix", async () => {
    const user = await say("ORIGINAL_REPLY_USER");
    const reply = await createThreadMessage(prisma, {
      threadId,
      role: "bot",
      botId,
      replyToMessageId: user.id,
      blocks: [{ kind: "text", text: "ORIGINAL_REPLY_BOT" }],
    });
    const checkpoint = await service.create(actor, { botId, expectedGeneration: 3 });
    await prisma.message.update({
      where: { id: user.id },
      data: { blocks: [{ kind: "text", text: "MUTATED_USER" }] },
    });
    await prisma.message.update({
      where: { id: reply.id },
      data: { blocks: [{ kind: "text", text: "MUTATED_BOT" }] },
    });
    expect(
      (await service.rollback(actor, { botId, checkpointId: checkpoint.id, expectedGeneration: 3 }))
        .ok,
    ).toBe(true);
    const rows = await prisma.message.findMany({
      where: await checkpointMessageWhere(prisma, threadId),
      orderBy: { seq: "asc" },
    });
    const restoredUser = rows.at(-2)!;
    const restoredReply = rows.at(-1)!;
    expect(restoredUser.blocks).toEqual([{ kind: "text", text: "ORIGINAL_REPLY_USER" }]);
    expect(restoredReply.blocks).toEqual([{ kind: "text", text: "ORIGINAL_REPLY_BOT" }]);
    expect(restoredUser.id).not.toBe(user.id);
    expect(restoredReply.replyToMessageId).toBe(restoredUser.id);
  });

  it("does not add rescue checkpoints when jumping without edits after restoration", async () => {
    const target = await prisma.checkpoint.findFirstOrThrow({
      where: { threadId, kind: "manual" },
      orderBy: { createdAt: "asc" },
    });
    const before = await prisma.checkpoint.count({ where: { threadId } });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
    const result = await service.rollback(actor, {
      botId,
      checkpointId: target.id,
      expectedGeneration: thread.checkpointGeneration,
    });
    expect(result.ok).toBe(true);
    expect(await prisma.checkpoint.count({ where: { threadId } })).toBe(before);
    const view = await service.list(actor, botId);
    expect(view.currentCheckpointId).toBe(target.id);
    expect(
      view.branches.find((branch) => branch.id === view.activeBranchId)?.parentCheckpointId,
    ).toBe(target.id);
    expect(view.checkpoints.find((node) => node.id === target.id)?.promptPreview).toBe("CLEAN_A");
  });

  it("accepts a newly created run after recovery while keeping old generations fenced", async () => {
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
    expect(thread.checkpointGeneration).toBeGreaterThan(0);
    const old = await prisma.run.findFirstOrThrow({ where: { threadId, checkpointGeneration: 0 } });
    const fresh = await prisma.$transaction(async (tx) => {
      const fields = await checkpointRunFields(tx, threadId);
      const task = await tx.task.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
          threadId,
          prompt: "Continue from the restored branch",
          status: "queued",
        },
      });
      return tx.run.create({
        data: {
          ...fields,
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
          threadId,
          taskId: task.id,
          status: "queued",
          trigger: "user",
        },
      });
    });
    expect(fresh.branchId).toBe(thread.activeBranchId);
    expect(fresh.checkpointGeneration).toBe(thread.checkpointGeneration);
    await expect(
      prisma.$transaction((tx) => assertRunCanWriteHistory(tx, fresh.id)),
    ).resolves.toBeDefined();
    await expect(prisma.$transaction((tx) => assertRunCanWriteHistory(tx, old.id))).rejects.toThrow(
      "Run cannot write",
    );
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: old.id } })).checkpointGeneration,
    ).toBe(0);
  });

  it("waits for a concurrent recovery fence before binding a new run", async () => {
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
    let releaseFence!: () => void;
    let fenceReady!: () => void;
    let waiterReady!: (pid: number) => void;
    const released = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      fenceReady = resolve;
    });
    const waiterPid = new Promise<number>((resolve) => {
      waiterReady = resolve;
    });
    const fence = prisma.$transaction(async (tx) => {
      await tx.thread.update({
        where: { id: threadId },
        data: { checkpointGeneration: { increment: 1 } },
      });
      fenceReady();
      await released;
    });
    await ready;
    let waiterFinished = false;
    const waiter = prisma
      .$transaction(async (tx) => {
        const [connection] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        waiterReady(connection!.pid);
        return checkpointRunFields(tx, threadId);
      })
      .finally(() => {
        waiterFinished = true;
      });
    try {
      const pid = await waiterPid;
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !waiterFinished; attempt++) {
        const [result] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked
        `;
        if (result?.blocked) {
          blocked = true;
          break;
        }
        await delay(10);
      }
      expect(blocked).toBe(true);
      releaseFence();
      const fields = await waiter;
      await fence;
      expect(fields).toEqual({
        branchId: thread.activeBranchId,
        checkpointGeneration: thread.checkpointGeneration + 1,
      });
    } finally {
      releaseFence();
      await Promise.allSettled([fence, waiter]);
    }
  });

  it("permanently deletes the bot while retaining research snapshots and referenced artifact bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkpoint-retention-"));
    try {
      await prisma.run.updateMany({
        where: { threadId },
        data: { status: "cancelled", completedAt: new Date() },
      });
      const context: AdapterContext = {
        ...actor,
        operationId: "retention-test",
        traceId: "retention-test",
        signal: new AbortController().signal,
      };
      const artifacts = new LocalArtifactStore(directory);
      const originalBytes = Buffer.from("original workbook bytes");
      const original = await artifacts.put(
        { name: "saved.xlsx", mimeType: "application/octet-stream", bytes: originalBytes },
        context,
      );
      const rootArtifact = await prisma.artifact.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
          name: "saved.xlsx",
          mimeType: "application/octet-stream",
          size: originalBytes.length,
          hash: hash(originalBytes.toString()),
          storageKey: original.id,
          checkpointHidden: true,
        },
      });
      const retainedBytes = Buffer.from("saved workbook bytes");
      const retained = await artifacts.put(
        { name: "saved.xlsx", mimeType: "application/octet-stream", bytes: retainedBytes },
        context,
      );
      const savedArtifact = await prisma.artifact.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
          name: "saved.xlsx",
          mimeType: "application/octet-stream",
          size: retainedBytes.length,
          hash: hash(retainedBytes.toString()),
          storageKey: retained.id,
          rootArtifactId: rootArtifact.id,
          version: 2,
        },
      });
      files = { "research.txt": "preserved research input" };
      const blob = path.join(
        directory,
        "checkpoint-blobs",
        actor.userId,
        botId,
        hash(files["research.txt"]!),
      );
      await mkdir(path.dirname(blob), { recursive: true });
      await writeFile(blob, files["research.txt"]!);
      const thread = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
      await service.create(actor, { botId, expectedGeneration: thread.checkpointGeneration });
      const before = await service.audit(actor, botId);
      const unsaved = await artifacts.put(
        {
          name: "unsaved.xlsx",
          mimeType: "application/octet-stream",
          bytes: Buffer.from("unsaved"),
        },
        context,
      );
      const unsavedArtifact = await prisma.artifact.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
          name: "unsaved.xlsx",
          mimeType: "application/octet-stream",
          size: 7,
          hash: hash("unsaved"),
          storageKey: unsaved.id,
        },
      });
      const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
      await prisma.computer.update({
        where: { id: bot.computerId! },
        data: {
          scopeKey: computerScopeKey("dedicated", actor.spaceId, botId),
        },
      });
      const enqueue = vi.fn();
      await destroyBot(
        {
          prisma,
          dataDir: directory,
          home: new LocalAgentHomeStore(directory),
          artifacts,
          jobs: {
            cancel: vi.fn().mockResolvedValue(undefined),
            enqueue,
          } as unknown as JobPublisher,
          sandbox: { destroy: vi.fn().mockResolvedValue(undefined) } as unknown as SandboxProvider,
        },
        bot,
        context,
        { deleteMemories: true },
      );

      expect(await prisma.bot.findUnique({ where: { id: botId } })).toBeNull();
      expect(await prisma.thread.findUnique({ where: { id: threadId } })).toBeNull();
      expect(await prisma.artifact.findUnique({ where: { id: unsavedArtifact.id } })).toBeNull();
      expect(
        await prisma.artifact.findUniqueOrThrow({ where: { id: savedArtifact.id } }),
      ).toMatchObject({
        botId: null,
        checkpointHidden: true,
        storageKey: retained.id,
      });
      expect(Buffer.from(await artifacts.get(retained.id, context))).toEqual(retainedBytes);
      expect(
        await prisma.artifact.findUniqueOrThrow({ where: { id: rootArtifact.id } }),
      ).toMatchObject({ botId: null, checkpointHidden: true });
      expect(Buffer.from(await artifacts.get(original.id, context))).toEqual(originalBytes);
      await expect(artifacts.get(unsaved.id, context)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(blob, "utf8")).toBe("preserved research input");
      const archive = await service.audit(actor, botId);
      expect(archive.checkpoints).toEqual(before.checkpoints);
      expect(archive.branches).toEqual(before.branches);
      expect(archive.audits).toEqual(before.audits);
      expect(archive.messages).toEqual([]);
      expect(archive.artifacts.some((item) => item.id === savedArtifact.id)).toBe(true);
      expect(archive.checkpoints.at(-1)!.businessState).toHaveProperty("transcript");
      await expect(service.audit({ ...actor, userId: "another-user" }, botId)).rejects.toThrow(
        "Resource not found",
      );
      await expect(service.audit({ ...actor, spaceId: "another-space" }, botId)).rejects.toThrow(
        "Resource not found",
      );
      await expect(
        service.rollback(actor, {
          botId,
          checkpointId: archive.checkpoints[0]!.id,
          expectedGeneration: 0,
        }),
      ).rejects.toThrow("Resource not found");
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
