import { expect, it, vi } from "vitest";
import {
  claimCheckpointWorkspace,
  releaseCheckpointWorkspace,
  withCheckpointWorkspaceWrite,
} from "./checkpoint-workspaces.js";
import type { PrismaClient } from "./client.js";

const input = {
  computerId: "computer",
  userId: "user",
  spaceId: "space",
  botId: "bot",
  owner: "checkpoint-restore:thread",
};
function fixture() {
  const computer = {
    id: "computer",
    userId: "user",
    spaceId: "space",
    scope: "dedicated",
    state: "running",
    providerRef: "sandbox",
    maintenanceId: null as string | null,
    controlHolder: "none",
    controlLeaseExpiresAt: null as Date | null,
    controlBotId: null as string | null,
    controlRunId: null as string | null,
  };
  const tx = {
    $queryRaw: vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => [
      { maintenanceId: computer.maintenanceId },
    ]),
    computer: {
      findUniqueOrThrow: vi.fn(async () => computer),
      update: vi.fn(async ({ data }) => Object.assign(computer, data)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    bot: { findFirst: vi.fn(async () => ({ id: "bot" })), count: vi.fn(async () => 0) },
    run: { count: vi.fn(async () => 0) },
    routine: { count: vi.fn(async () => 0) },
    thread: { findFirst: vi.fn<() => Promise<{ id: string } | null>>().mockResolvedValue(null) },
    rollbackAuditLog: {
      findFirst: vi
        .fn<() => Promise<{ details: Record<string, unknown> } | null>>()
        .mockResolvedValue(null),
    },
  };
  let committed = false;
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (operation) => {
      const value = await operation(tx);
      committed = true;
      return value;
    }),
  } as unknown as PrismaClient;
  return {
    computer,
    tx,
    prisma,
    get committed() {
      return committed;
    },
  };
}

it("claims the shared Computer only after locking and checking all attached writers", async () => {
  const f = fixture();
  await claimCheckpointWorkspace(f.prisma, input);
  expect(f.tx.$queryRaw.mock.calls[0]![0].join("")).toContain("FOR UPDATE");
  expect(f.tx.run.count).toHaveBeenCalledWith({
    where: {
      bot: { computerId: "computer" },
      status: { in: expect.any(Array) },
    },
  });
  expect(f.computer.maintenanceId).toBe(input.owner);
  expect(f.committed).toBe(true);
});

it("claims a Team Computer owned by the same account and Space", async () => {
  const f = fixture();
  f.computer.scope = "team";
  await claimCheckpointWorkspace(f.prisma, input);
  expect(f.computer.maintenanceId).toBe(input.owner);
  expect(f.tx.bot.count).toHaveBeenCalledWith({
    where: {
      computerId: "computer",
      OR: [{ userId: { not: "user" } }, { spaceId: { not: "space" } }],
    },
  });
});

it.each(["owner", "space", "attached-bot", "run", "watch", "control"])(
  "rejects a Team checkpoint with foreign ownership or active %s",
  async (kind) => {
    const f = fixture();
    f.computer.scope = "team";
    if (kind === "owner") f.computer.userId = "other";
    if (kind === "space") f.computer.spaceId = "other";
    if (kind === "attached-bot") f.tx.bot.count.mockResolvedValue(1);
    if (kind === "run") f.tx.run.count.mockResolvedValue(1);
    if (kind === "watch") f.tx.routine.count.mockResolvedValue(1);
    if (kind === "control") f.computer.controlHolder = "user";
    await expect(claimCheckpointWorkspace(f.prisma, { ...input, restore: true })).rejects.toThrow();
    expect(f.tx.computer.update).not.toHaveBeenCalled();
  },
);

it("refuses another Bot's active run before any maintenance state is changed", async () => {
  const f = fixture();
  f.tx.run.count.mockResolvedValue(1);
  await expect(claimCheckpointWorkspace(f.prisma, { ...input, restore: true })).rejects.toThrow(
    "Another task",
  );
  expect(f.tx.run.count).toHaveBeenCalledWith({
    where: {
      bot: { computerId: "computer" },
      botId: { not: "bot" },
      status: { in: expect.any(Array) },
    },
  });
  expect(f.tx.computer.update).not.toHaveBeenCalled();
});

it("permits only the initiating turn at an automatic capture boundary", async () => {
  const f = fixture();
  await claimCheckpointWorkspace(f.prisma, { ...input, allowedRunId: "run" });
  expect(f.tx.run.count).toHaveBeenCalledWith({
    where: {
      bot: { computerId: "computer" },
      id: { not: "run" },
      status: { in: expect.any(Array) },
    },
  });
});

it("refuses active watched jobs and human control", async () => {
  const watched = fixture();
  watched.tx.routine.count.mockResolvedValue(1);
  await expect(claimCheckpointWorkspace(watched.prisma, input)).rejects.toThrow("watched jobs");
  const controlled = fixture();
  controlled.computer.controlHolder = "user";
  controlled.computer.controlLeaseExpiresAt = new Date(Date.now() + 60_000);
  await expect(
    claimCheckpointWorkspace(controlled.prisma, { ...input, restore: true }),
  ).rejects.toThrow("Release workspace control");
  controlled.computer.controlLeaseExpiresAt = new Date(0);
  await expect(claimCheckpointWorkspace(controlled.prisma, input)).rejects.toThrow(
    "Release workspace control",
  );
});

it("rejects a different account or an existing foreign maintenance owner", async () => {
  const foreign = fixture();
  foreign.computer.userId = "another-user";
  await expect(claimCheckpointWorkspace(foreign.prisma, input)).rejects.toThrow("unavailable");
  const maintenance = fixture();
  maintenance.computer.maintenanceId = "checkpoint-restore:another-thread";
  await expect(claimCheckpointWorkspace(maintenance.prisma, input)).rejects.toThrow("maintenance");
  maintenance.computer.maintenanceId = input.owner;
  await expect(claimCheckpointWorkspace(maintenance.prisma, input)).rejects.toThrow("maintenance");
});

it("releases only its own maintenance fence", async () => {
  const f = fixture();
  await releaseCheckpointWorkspace(f.prisma, "computer", input.owner);
  expect(f.tx.computer.updateMany).toHaveBeenCalledWith({
    where: { id: "computer", maintenanceId: input.owner },
    data: { maintenanceId: null },
  });
});

it("holds the shared row lock until the entire file operation completes", async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = vi.fn(async () => {
    await held;
    return "saved";
  });
  const write = withCheckpointWorkspaceWrite(f.prisma, "computer", operation);
  await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
  expect(f.committed).toBe(false);
  expect(f.tx.$queryRaw.mock.calls[0]![0].join("")).toContain("FOR SHARE");
  release();
  expect(await write).toBe("saved");
  expect(f.committed).toBe(true);
});

it("never calls a file operation while checkpoint maintenance is held", async () => {
  const f = fixture();
  f.computer.maintenanceId = input.owner;
  const operation = vi.fn();
  await expect(withCheckpointWorkspaceWrite(f.prisma, "computer", operation)).rejects.toThrow(
    "maintenance",
  );
  expect(operation).not.toHaveBeenCalled();
});

it("refuses a busy Computer row without consuming another connection for a long operation", async () => {
  const f = fixture();
  f.tx.$queryRaw.mockResolvedValueOnce([]);
  await expect(claimCheckpointWorkspace(f.prisma, input)).rejects.toThrow("Another operation");
  expect(f.tx.computer.update).not.toHaveBeenCalled();
  expect(f.tx.$queryRaw.mock.calls[0]![0].join("")).toContain("FOR UPDATE SKIP LOCKED");
});

const retry = {
  ...input,
  owner: "checkpoint-restore:next-attempt",
  restore: true,
  retry: { threadId: "thread", expectedGeneration: 7 },
};

it("transfers failed recovery ownership only after matching the blocked generation and failed audit", async () => {
  const f = fixture();
  f.computer.maintenanceId = input.owner;
  f.tx.thread.findFirst.mockResolvedValue({ id: "thread" });
  f.tx.rollbackAuditLog.findFirst.mockResolvedValue({
    details: {
      workspaceMaintenanceOwner: input.owner,
      workspaceComputerId: "computer",
    },
  });
  await claimCheckpointWorkspace(f.prisma, retry);
  expect(f.computer.maintenanceId).toBe(retry.owner);
  expect(f.tx.thread.findFirst).toHaveBeenCalledWith({
    where: {
      id: "thread",
      botId: "bot",
      userId: "user",
      spaceId: "space",
      checkpointBlocked: true,
      checkpointGeneration: 7,
    },
    select: { id: true },
  });
  expect(f.tx.rollbackAuditLog.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        threadId: "thread",
        botId: "bot",
        userId: "user",
        spaceId: "space",
        generation: 7,
        status: "failed",
      },
    }),
  );
});

it.each([
  null,
  { details: { workspaceMaintenanceOwner: "another-attempt", workspaceComputerId: "computer" } },
  { details: { workspaceMaintenanceOwner: input.owner, workspaceComputerId: "another-computer" } },
])("never steals an active or unrelated failed maintenance owner: %j", async (proof) => {
  const f = fixture();
  f.computer.maintenanceId = input.owner;
  f.tx.thread.findFirst.mockResolvedValue({ id: "thread" });
  f.tx.rollbackAuditLog.findFirst.mockResolvedValue(proof);
  await expect(claimCheckpointWorkspace(f.prisma, retry)).rejects.toThrow(
    "not completed or failed",
  );
  expect(f.tx.computer.update).not.toHaveBeenCalled();
});

it("rejects retry when the current thread no longer matches the blocked generation", async () => {
  const f = fixture();
  f.computer.maintenanceId = input.owner;
  await expect(claimCheckpointWorkspace(f.prisma, retry)).rejects.toThrow(
    "not completed or failed",
  );
  expect(f.tx.rollbackAuditLog.findFirst).not.toHaveBeenCalled();
  expect(f.tx.computer.update).not.toHaveBeenCalled();
});
