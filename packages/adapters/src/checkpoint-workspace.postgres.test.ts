import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  checkpointMessageWhere,
  createDb,
  createThreadMessage,
  withCheckpointWorkspaceWrite,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CheckpointFiles } from "./checkpoint-files.js";
import { CheckpointService } from "./checkpoint-service.js";
import { destroyBot } from "./child-bots.js";
import { LocalAgentHomeStore } from "./home.js";

const connection = process.env.CHECKPOINT_TEST_DATABASE_URL;
const enabled =
  process.platform === "linux" &&
  connection &&
  /^rakazo_checkpoint_[a-z0-9_]+$/.test(new URL(connection).pathname.slice(1));
const execute = promisify(execFile);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function usage(directory: string) {
  let logical = 0,
    physical = 0,
    files = 0;
  const inodes = new Set<string>();
  async function walk(folder: string) {
    for (const name of await readdir(folder)) {
      const full = path.join(folder, name),
        info = await lstat(full);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        files++;
        logical += info.size;
        const key = `${info.dev}:${info.ino}`;
        if (!inodes.has(key)) {
          inodes.add(key);
          physical += info.blocks * 512;
        }
      }
    }
  }
  await walk(directory);
  return { logical, physical, files, uniqueFiles: inodes.size };
}

describe.skipIf(!enabled).sequential.each(["dedicated", "team"] as const)(
  "%s workspace checkpoints on Linux",
  (mode) => {
    const scope = `workspace-${randomUUID()}`;
    const actor: Actor = {
      userId: `${scope}-user`,
      spaceId: `${scope}-space`,
      email: "test@example.invalid",
      isDeploymentOwner: false,
    };
    const db = enabled ? createDb(connection!, { poolMax: 4 }) : undefined;
    let prisma: PrismaClient;
    let root: string;
    let service: CheckpointService;
    let files: CheckpointFiles;
    let sandbox: SandboxProvider;
    const homeByRef = new Map<string, string>();
    const a = `${scope}-a`,
      b = `${scope}-b`;
    const threadId = (botId: string) => `${botId}-thread`;
    const context = (): AdapterContext => ({
      ...actor,
      operationId: "workspace-test",
      traceId: "workspace-test",
      signal: AbortSignal.timeout(120_000),
    });

    beforeAll(async () => {
      prisma = db!.prisma;
      vi.stubEnv("TEAM_MANAGEMENT_ENABLED", "0");
      vi.stubEnv("CHECKPOINT_DIRECT_DOCKER", "1");
      root = await mkdtemp(path.join(tmpdir(), "checkpoint-workspace-"));
      await prisma.organization.create({
        data: { id: scope, slug: scope, name: "Synthetic workspace test", createdAt: new Date() },
      });
      await prisma.user.create({
        data: { id: actor.userId, email: `${scope}@example.invalid`, name: "Synthetic" },
      });
      await prisma.space.create({
        data: { id: actor.spaceId, organizationId: scope, name: "Synthetic" },
      });
      // Execute the actual Python process helpers against isolated mount equivalents.
      sandbox = {
        execute: async function* (computer: ComputerRef, request: CommandRequest) {
          const home = homeByRef.get(computer.id)!;
          try {
            const result = await execute(
              "python3",
              request.argv.slice(1).map((value) => value.replaceAll("/home/rakazo", home)),
              { cwd: home, timeout: request.timeoutMs },
            );
            yield { type: "stdout", data: result.stdout };
            yield { type: "exit", code: 0 };
          } catch (error) {
            yield { type: "stderr", data: String((error as { stderr?: string }).stderr ?? error) };
            yield { type: "exit", code: 1 };
          }
        },
        destroy: vi.fn(async () => undefined),
      } as unknown as SandboxProvider;
      service = new CheckpointService({ prisma, sandbox, dataDir: root });
      files = new CheckpointFiles({ sandbox, dataDir: root });
      Object.assign(service, { files });
    });

    afterAll(async () => {
      if (!db) return;
      try {
        await prisma.rollbackAuditLog.deleteMany({ where: { spaceId: actor.spaceId } });
        await prisma.checkpoint.deleteMany({ where: { spaceId: actor.spaceId } });
        await prisma.conversationBranch.deleteMany({ where: { threadId: { startsWith: scope } } });
        await prisma.organization.delete({ where: { id: scope } });
        await prisma.user.delete({ where: { id: actor.userId } });
      } finally {
        await prisma.$disconnect();
        await db.pool.end();
        if (root) await rm(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    });

    async function bot(botId: string, requestedMode: "dedicated" | "team" = mode) {
      const sharedHome = `${scope}-team`;
      const homeKey = requestedMode === "team" ? sharedHome : botId;
      const computerId = `${homeKey}-computer`;
      const computer = await prisma.computer.upsert({
        where: { id: computerId },
        update: {},
        create: {
          id: computerId,
          scopeKey:
            requestedMode === "team" ? `team:${actor.spaceId}:${actor.userId}` : `bot:${botId}`,
          homeKey,
          scope: requestedMode,
          kind: "docker",
          providerRef: homeKey,
          state: "running",
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      });
      const home = path.join(root, "homes", homeKey);
      const workspace =
        requestedMode === "team" ? path.join(home, "bots", botId) : path.join(home, "workspace");
      await mkdir(workspace, { recursive: true });
      if (requestedMode === "team") await mkdir(path.join(home, "shared"), { recursive: true });
      homeByRef.set(homeKey, home);
      await prisma.bot.create({
        data: {
          id: botId,
          computerId: computer.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          name: "Same name",
          color: "blue",
          instructions: `INSTRUCTIONS:${botId}`,
        },
      });
      await prisma.thread.create({
        data: { id: threadId(botId), botId, userId: actor.userId, spaceId: actor.spaceId },
      });
      await createThreadMessage(prisma, {
        threadId: threadId(botId),
        role: "user",
        blocks: [{ kind: "text", text: `PROMPT:${botId}` }],
      });
      return { computer, workspace, home };
    }
    const save = async (botId: string) =>
      service.create(actor, {
        botId,
        expectedGeneration: (
          await prisma.thread.findUniqueOrThrow({ where: { id: threadId(botId) } })
        ).checkpointGeneration,
      });
    const restore = async (botId: string, checkpointId: string) =>
      service.rollback(actor, {
        botId,
        checkpointId,
        expectedGeneration: (
          await prisma.thread.findUniqueOrThrow({ where: { id: threadId(botId) } })
        ).checkpointGeneration,
      });
    const blob = (botId: string, digest: string) =>
      path.join(root, "checkpoint-blobs", actor.userId, botId, digest);
    const visible = async (botId: string) =>
      prisma.message.findMany({
        where: await checkpointMessageWhere(prisma, threadId(botId)),
        orderBy: { seq: "asc" },
      });

    it("deduplicates incremental files across the same Bot's branches without sharing another Bot's pool", async () => {
      const ownId = `${scope}-incremental`;
      const otherId = `${scope}-independent`;
      const own = await bot(ownId);
      const other = await bot(otherId);
      const common = "unchanged input\n".repeat(10_000);
      await writeFile(path.join(own.workspace, "input.txt"), common);
      await writeFile(path.join(own.workspace, "change.txt"), "first version");
      await writeFile(path.join(own.workspace, "deleted.txt"), "removed later");
      await writeFile(path.join(other.workspace, "input.txt"), common);
      const initial = await save(ownId);
      const independent = await save(otherId);
      expect((await lstat(blob(ownId, hash(common)))).ino).not.toBe(
        (await lstat(blob(otherId, hash(common)))).ino,
      );
      await expect(restore(otherId, initial.id)).rejects.toThrow();
      expect((await service.list(actor, otherId)).checkpoints.map((node) => node.id)).toEqual([
        independent.id,
      ]);
      await writeFile(path.join(own.workspace, "change.txt"), "second version");
      await unlink(path.join(own.workspace, "deleted.txt"));
      await writeFile(path.join(own.workspace, "new.txt"), "new content");
      const later = await save(ownId);
      const version = await lstat(blob(ownId, hash("second version")));
      const poolAfterLater = await usage(path.join(root, "checkpoint-blobs", actor.userId, ownId));
      expect((await restore(ownId, initial.id)).ok).toBe(true);
      expect(await readFile(path.join(own.workspace, "change.txt"), "utf8")).toBe("first version");
      await writeFile(path.join(own.workspace, "change.txt"), "second version");
      await unlink(path.join(own.workspace, "deleted.txt"));
      await writeFile(path.join(own.workspace, "new.txt"), "new content");
      const branched = await save(ownId);
      expect(branched.branchId).not.toBe(later.branchId);
      expect((await lstat(blob(ownId, hash("second version")))).ino).toBe(version.ino);
      expect(await usage(path.join(root, "checkpoint-blobs", actor.userId, ownId))).toEqual(
        poolAfterLater,
      );
      expect(await readFile(path.join(other.workspace, "input.txt"), "utf8")).toBe(common);
    }, 30_000);

    it.skipIf(mode !== "team")(
      "restores only the owning Team Bot directory and leaves shared and peer files unchanged",
      async () => {
        const source = await bot(a);
        const peer = await bot(b);
        expect(peer.computer.id).toBe(source.computer.id);
        expect(peer.workspace).not.toBe(source.workspace);
        const shared = path.join(source.home, "shared");
        await writeFile(path.join(shared, "policy.txt"), "shared before any checkpoint");
        await writeFile(path.join(source.workspace, "input.txt"), "same private bytes");
        await writeFile(path.join(source.workspace, "change.txt"), "source first version");
        await writeFile(path.join(source.workspace, "deleted.txt"), "source deleted later");
        await writeFile(path.join(peer.workspace, "input.txt"), "same private bytes");
        await writeFile(path.join(peer.workspace, "change.txt"), "peer first version");
        const first = await save(a);
        await writeFile(path.join(source.workspace, "change.txt"), "source later branch");
        const later = await save(a);
        const recipient = await save(b);
        const manifest = recipient.fileManifest as {
          version: number;
          roots: string[];
          entries: Array<{ path: string; type: string }>;
        };
        expect(manifest).toMatchObject({ version: 2, roots: [`bots/${b}`] });
        expect(
          manifest.entries.every(
            (entry) => entry.path === `bots/${b}` || entry.path.startsWith(`bots/${b}/`),
          ),
        ).toBe(true);
        expect(manifest.entries.some((entry) => entry.path.startsWith("shared"))).toBe(false);
        expect((await lstat(blob(b, hash("same private bytes")))).ino).not.toBe(
          (await lstat(blob(a, hash("same private bytes")))).ino,
        );
        expect(recipient.businessState).toMatchObject({
          parentCheckpointId: null,
          binding: null,
          botInstructions: `INSTRUCTIONS:${b}`,
        });
        expect(JSON.stringify(recipient.businessState)).not.toContain(`PROMPT:${a}`);
        expect((await service.list(actor, b)).checkpoints.map((entry) => entry.id)).toEqual([
          recipient.id,
        ]);
        await expect(restore(b, first.id)).rejects.toThrow();
        await expect(
          service.create({ ...actor, userId: "wrong-user" }, { botId: b, expectedGeneration: 0 }),
        ).rejects.toThrow();

        await writeFile(path.join(shared, "policy.txt"), "shared changed after both checkpoints");
        await writeFile(path.join(shared, "new.txt"), "shared added after both checkpoints");
        await writeFile(path.join(source.workspace, "change.txt"), "source live draft");
        await unlink(path.join(source.workspace, "deleted.txt"));
        await writeFile(path.join(source.workspace, "new.txt"), "source new draft");
        await writeFile(path.join(peer.workspace, "change.txt"), "peer live draft");
        const peerGeneration = (
          await prisma.thread.findUniqueOrThrow({ where: { id: threadId(b) } })
        ).checkpointGeneration;
        const started = gate(),
          finish = gate();
        const restoreFiles = files.restore.bind(files);
        const interception = vi.spyOn(files, "restore").mockImplementationOnce(async (...args) => {
          started.resolve();
          await finish.promise;
          return restoreFiles(...args);
        });
        const restoring = restore(a, first.id);
        await started.promise;
        try {
          await expect(save(b)).rejects.toThrow(/workspace|maintenance/i);
          await expect(
            withCheckpointWorkspaceWrite(prisma, source.computer.id, async () => undefined),
          ).rejects.toThrow(/maintenance/i);
        } finally {
          finish.resolve();
        }
        const rolled = await restoring;
        interception.mockRestore();
        expect(rolled.ok).toBe(true);
        expect(await readFile(path.join(source.workspace, "change.txt"), "utf8")).toBe(
          "source first version",
        );
        expect(await readFile(path.join(source.workspace, "deleted.txt"), "utf8")).toBe(
          "source deleted later",
        );
        await expect(readFile(path.join(source.workspace, "new.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(path.join(peer.workspace, "change.txt"), "utf8")).toBe(
          "peer live draft",
        );
        expect(await readFile(path.join(shared, "policy.txt"), "utf8")).toBe(
          "shared changed after both checkpoints",
        );
        expect(await readFile(path.join(shared, "new.txt"), "utf8")).toBe(
          "shared added after both checkpoints",
        );
        expect(
          (await prisma.thread.findUniqueOrThrow({ where: { id: threadId(b) } }))
            .checkpointGeneration,
        ).toBe(peerGeneration);
        expect((await visible(b)).map((message) => message.blocks)).toEqual([
          [{ kind: "text", text: `PROMPT:${b}` }],
        ]);

        if (!rolled.ok) throw new Error("Expected rollback success");
        expect((await restore(a, rolled.rescueCheckpointId)).ok).toBe(true);
        expect(await readFile(path.join(source.workspace, "change.txt"), "utf8")).toBe(
          "source live draft",
        );
        expect((await restore(b, recipient.id)).ok).toBe(true);
        expect(await readFile(path.join(peer.workspace, "change.txt"), "utf8")).toBe(
          "peer first version",
        );
        expect(await readFile(path.join(source.workspace, "change.txt"), "utf8")).toBe(
          "source live draft",
        );
        expect((await restore(a, later.id)).ok).toBe(true);
        expect(await readFile(path.join(source.workspace, "change.txt"), "utf8")).toBe(
          "source later branch",
        );
        expect(await readFile(path.join(shared, "policy.txt"), "utf8")).toBe(
          "shared changed after both checkpoints",
        );

        expect((await restore(a, first.id)).ok).toBe(true);
        expect(await readFile(path.join(source.workspace, "change.txt"), "utf8")).toBe(
          "source first version",
        );
        expect(await readFile(path.join(shared, "policy.txt"), "utf8")).toBe(
          "shared changed after both checkpoints",
        );
        expect(await readFile(path.join(peer.workspace, "change.txt"), "utf8")).toBe(
          "peer first version",
        );

        await prisma.checkpoint.deleteMany({ where: { botId: a } });
        await rm(path.join(root, "checkpoint-blobs", actor.userId, a), {
          recursive: true,
          force: true,
        });
        await destroyBot(
          {
            prisma,
            sandbox,
            dataDir: root,
            home: new LocalAgentHomeStore(root),
            jobs: { cancel: vi.fn(async () => undefined) } as unknown as JobPublisher,
          },
          await prisma.bot.findUniqueOrThrow({ where: { id: a } }),
          context(),
          { deleteMemories: true },
        );
        await writeFile(
          path.join(peer.workspace, "input.txt"),
          "peer modified after source deletion",
        );
        expect((await restore(b, recipient.id)).ok).toBe(true);
        expect(await readFile(path.join(peer.workspace, "input.txt"), "utf8")).toBe(
          "same private bytes",
        );
        expect(await readFile(path.join(shared, "policy.txt"), "utf8")).toBe(
          "shared changed after both checkpoints",
        );
        expect(
          await prisma.computer.findUnique({ where: { id: source.computer.id } }),
        ).not.toBeNull();
      },
      120_000,
    );

    it("captures four unrelated workspaces concurrently with the standard four-connection pool", async () => {
      const ids = [0, 1, 2, 3].map((index) => `${scope}-parallel-${index}`);
      for (const id of ids) {
        const created = await bot(id, "dedicated");
        await writeFile(path.join(created.workspace, "data.txt"), `data:${id}`);
      }
      const snapshots = await Promise.all(ids.map(save));
      expect(new Set(snapshots.map((snapshot) => snapshot.workspaceKey)).size).toBe(4);
    }, 30_000);

    it.skipIf(!process.env.CHECKPOINT_BENCHMARK_SOURCE)(
      "measures a real isolated workspace copy without changing the source",
      async () => {
        const left = `${scope}-bench`;
        const source = await bot(left);
        await cp(process.env.CHECKPOINT_BENCHMARK_SOURCE!, source.workspace, {
          recursive: true,
          dereference: false,
        });
        await writeFile(path.join(source.workspace, ".benchmark-change.txt"), "before");
        await writeFile(path.join(source.workspace, ".benchmark-delete.txt"), "remove");
        const workspace = await usage(source.workspace);
        const beforeFirst = await usage(path.join(root, "checkpoint-blobs"));
        let started = performance.now();
        const first = await save(left);
        const firstMs = performance.now() - started;
        const afterFirst = await usage(path.join(root, "checkpoint-blobs"));
        const firstPool = await usage(path.join(root, "checkpoint-blobs", actor.userId, left));
        await writeFile(path.join(source.workspace, ".benchmark-change.txt"), "after");
        await unlink(path.join(source.workspace, ".benchmark-delete.txt"));
        await writeFile(path.join(source.workspace, ".benchmark-added.txt"), "new");
        started = performance.now();
        await save(left);
        const incrementalMs = performance.now() - started;
        const afterIncremental = await usage(path.join(root, "checkpoint-blobs"));
        const currentPool = await usage(path.join(root, "checkpoint-blobs", actor.userId, left));
        started = performance.now();
        const restored = await restore(left, first.id);
        const restoreMs = performance.now() - started;
        const afterRestore = await usage(path.join(root, "checkpoint-blobs"));
        expect(restored.ok).toBe(true);
        process.stdout.write(
          `CHECKPOINT_WORKSPACE_BENCHMARK ${JSON.stringify({
            mode,
            comparison: "same-bot incremental save",
            workspace,
            firstMs,
            incrementalMs,
            restoreMs,
            beforeFirst,
            firstPool,
            afterFirst,
            afterIncremental,
            afterRestore,
            currentPool,
            addedPhysicalBytes: afterIncremental.physical - afterFirst.physical,
          })}\n`,
        );
      },
      240_000,
    );
  },
);
