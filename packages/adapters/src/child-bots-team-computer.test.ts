import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { archiveBot, destroyBot } from "./child-bots.js";
import { LocalAgentHomeStore } from "./home.js";

it.each(["archive-first", "delete-first", "delete-second", "delete-last"])(
  "%s keeps the Team Computer and its workspace",
  async (operation) => {
    const scope = "team";
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-lifecycle-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const workspace = path.join(home.pathFor("team-home"), "shared");
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, "rules.rost"), "research state");
      const computer = {
        id: "computer",
        homeKey: "team-home",
        scope,
        spaceId: "space",
        userId: "owner",
        kind: "docker",
        providerRef: "container",
        state: "running",
        maintenanceId: null as string | null,
        controlBotId: "second",
        executionBotId: "second",
      };
      const bots = (operation === "delete-last" ? ["first"] : ["first", "second"]).map((id) => ({
        id,
        spaceId: "space",
        userId: "owner",
        name: id,
        archivedAt: null as Date | null,
        computerId: computer.id,
      }));
      const deletedComputer = vi.fn();
      const updateMany = vi.fn(async ({ where, data }) => {
        if (
          (where.id === undefined || where.id === computer.id) &&
          (where.maintenanceId === undefined || where.maintenanceId === computer.maintenanceId) &&
          (where.controlBotId === undefined || where.controlBotId === computer.controlBotId) &&
          (where.executionBotId === undefined || where.executionBotId === computer.executionBotId)
        )
          Object.assign(computer, data);
        return { count: 1 };
      });
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        checkpoint: { findMany: vi.fn().mockResolvedValue([]) },
        computer: {
          findUniqueOrThrow: vi.fn(async () => ({ ...computer })),
          update: vi.fn(async ({ data }) => Object.assign(computer, data)),
          updateMany,
          delete: deletedComputer,
        },
        bot: {
          findUnique: vi.fn(async ({ where }) => bots.find((bot) => bot.id === where.id)),
          update: vi.fn(async ({ where, data }) =>
            Object.assign(bots.find((bot) => bot.id === where.id)!, data),
          ),
          delete: vi.fn(async ({ where }) => {
            const index = bots.findIndex((bot) => bot.id === where.id);
            bots.splice(index, 1);
          }),
        },
        run: { updateMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
        task: { updateMany: vi.fn() },
        routine: { updateMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
        computerExecutionLease: { updateMany: vi.fn(), deleteMany: vi.fn() },
        artifact: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
        chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
        botDeletion: { create: vi.fn() },
      };
      const prisma = {
        ...tx,
        computer: {
          ...tx.computer,
          findUnique: vi.fn(async ({ where }) =>
            where.id === computer.id ? { ...computer } : null,
          ),
        },
        run: { ...tx.run, findMany: vi.fn().mockResolvedValue([]) },
        routine: { ...tx.routine, findMany: vi.fn().mockResolvedValue([]) },
        $transaction: vi.fn(async (callback) => callback(tx)),
      } as unknown as PrismaClient;
      const stop = vi.fn(),
        destroy = vi.fn();
      const target = bots.find(
        (bot) => bot.id === (operation === "delete-second" ? "second" : "first"),
      )!;
      const context: AdapterContext = {
        userId: "owner",
        spaceId: "space",
        botId: target.id,
        operationId: "test",
        traceId: "test",
        signal: new AbortController().signal,
      };
      const deps = {
        prisma,
        home,
        sandbox: { stop, destroy } as unknown as SandboxProvider,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      };
      if (operation === "archive-first") await archiveBot(deps, target, context);
      else await destroyBot(deps, target, context, { deleteMemories: true });
      expect(stop).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(deletedComputer).not.toHaveBeenCalled();
      expect(await readFile(path.join(workspace, "rules.rost"), "utf8")).toBe("research state");
      expect(computer.maintenanceId).toBeNull();
      if (target.id === "first") {
        expect(computer.controlBotId).toBe("second");
        expect(computer.executionBotId).toBe("second");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(
  ["archive", "delete"].flatMap((operation) =>
    ["checkpoint-save:owner", "checkpoint-restore:owner"].map((maintenanceId) => ({
      operation,
      maintenanceId,
    })),
  ),
)(
  "rejects Team $operation during $maintenanceId before changing Bot state",
  async ({ operation, maintenanceId }) => {
    const computer = { id: "team-computer", scope: "team", maintenanceId };
    const update = vi.fn();
    const cancel = vi.fn();
    const stop = vi.fn();
    const destroy = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(computer),
        update,
      },
      bot: { update, delete: update },
    };
    const prisma = {
      ...tx,
      computer: { ...tx.computer, findUnique: vi.fn().mockResolvedValue(computer) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as unknown as PrismaClient;
    const bot = {
      id: "bot",
      name: "Bot",
      spaceId: "space",
      userId: "owner",
      computerId: computer.id,
      archivedAt: null,
    };
    const context: AdapterContext = {
      userId: "owner",
      spaceId: "space",
      botId: bot.id,
      operationId: "test",
      traceId: "test",
      signal: new AbortController().signal,
    };
    const deps = {
      prisma,
      home: new LocalAgentHomeStore("unused"),
      sandbox: { stop, destroy } as unknown as SandboxProvider,
      jobs: { cancel } as unknown as JobPublisher,
    };
    await expect(
      operation === "archive"
        ? archiveBot(deps, bot, context)
        : destroyBot(deps, bot, context, { deleteMemories: true }),
    ).rejects.toThrow("Workspace is busy");
    expect(update).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  },
);
