import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";

const actor: Actor = { userId: "owner", spaceId: "space", email: "", isDeploymentOwner: false };

function fixture() {
  const computer = (id: string) => ({
    id,
    scope: "dedicated",
    kind: "fake",
    userId: "owner",
    spaceId: "space",
    maintenanceId: null as string | null,
    controlHolder: "none",
    controlLeaseExpiresAt: null as Date | null,
  });
  const bot = (id: string) => ({
    id,
    userId: "owner",
    spaceId: "space",
    name: id,
    title: "",
    description: "",
    instructions: `instructions ${id}`,
    color: "ink",
    notifyOnFinish: true,
    pinned: false,
    position: 0,
    sectionId: null,
    archivedAt: null as Date | null,
    parentBotId: null,
    memoryScope: null,
    computerSwitching: false,
    computerId: `computer-${id}`,
    computer: computer(`computer-${id}`),
    thread: { id: `thread-${id}`, unread: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const target = bot("target"),
    source = bot("source");
  const rows = [target, source];
  const computers = new Map([target.computer, source.computer].map((item) => [item.id, item]));
  const ownComputer = target.computer;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR")
        return (value as Record<string, unknown>[]).some((term) => matches(row, term));
      if (value && typeof value === "object" && "not" in value) return row[key] !== value.not;
      return row[key] === value;
    });
  const findFirst = vi.fn(async ({ where }) => rows.find((row) => matches(row, where)) ?? null);
  const update = vi.fn(async ({ where, data }) => {
    const row = rows.find((item) => item.id === where.id)!;
    Object.assign(row, data);
    row.computer = computers.get(data.computerId)!;
    return row;
  });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    computer: {
      findMany: vi.fn(async ({ where }) =>
        [...computers.values()].filter((item) => where.id.in.includes(item.id)),
      ),
      upsert: vi.fn(async ({ where, create }) => {
        if (where.scopeKey === "bot:target") return ownComputer;
        const next = { ...computer("computer-team"), ...create };
        computers.set(next.id, next);
        return next;
      }),
    },
    bot: {
      findFirst,
      update,
      aggregate: vi.fn().mockResolvedValue({ _max: { position: null } }),
      create: vi.fn(async ({ data }) => Object.assign(target, data)),
      findFirstOrThrow: vi.fn(async () => ({
        ...target,
        computer: computers.get(target.computerId),
      })),
    },
    thread: { create: vi.fn(async () => target.thread) },
    browserProfile: { create: vi.fn() },
    memoryDocument: { create: vi.fn() },
    spaceMember: {
      findUnique: vi.fn().mockResolvedValue({ organizationId: "org", space: { deletingAt: null } }),
    },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    run: { findFirst: vi.fn().mockResolvedValue(null) },
    routine: { findFirst: vi.fn().mockResolvedValue(null) },
    checkpoint: { create: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  return { source, target, ownComputer, computers, rows, tx, repos: createRepos(prisma) };
}

it.each(["maintenance", "run", "watch", "control"])(
  "refuses a mode switch during %s activity",
  async (kind) => {
    const f = fixture();
    if (kind === "maintenance") f.target.computer.maintenanceId = "checkpoint-operation";
    if (kind === "run") f.tx.run.findFirst.mockResolvedValue({ id: "active" });
    if (kind === "watch") f.tx.routine.findFirst.mockResolvedValue({ id: "watch" });
    if (kind === "control") {
      f.target.computer.controlHolder = "user";
      f.target.computer.controlLeaseExpiresAt = new Date(Date.now() + 60000);
    }
    await expect(f.repos.setBotComputer(actor, "target", "team")).rejects.toThrow();
    expect(f.tx.bot.update).not.toHaveBeenCalled();
  },
);

it("switches an owned Bot to its Team Computer", async () => {
  vi.stubEnv("TEAM_MANAGEMENT_ENABLED", "0");
  vi.stubEnv("AGENT_RUNTIME", "scripted");
  try {
    const f = fixture();
    const result = await f.repos.setBotComputer(actor, "target", "team");
    expect(result.computerMode).toBe("team");
    expect(f.target.computerId).toBe("computer-team");
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("does not overwrite a concurrent assignment or switching claim", async () => {
  const f = fixture();
  f.target.computerSwitching = true;
  await expect(f.repos.setBotComputer(actor, "target", "dedicated")).rejects.toThrow(
    "Workspace assignment changed",
  );
  expect(f.tx.bot.update).not.toHaveBeenCalled();
});

it.each(["0", "1"])(
  "preserves legacy Team Computer Space permissions with managed mode %s",
  async (managed) => {
    vi.stubEnv("TEAM_MANAGEMENT_ENABLED", managed);
    vi.stubEnv("AGENT_RUNTIME", "scripted");
    try {
      const f = fixture();
      const team = {
        ...f.ownComputer,
        id: "existing-team",
        scope: "team",
        userId: "another-member",
      };
      f.computers.set(team.id, team);
      f.tx.computer.upsert.mockResolvedValue(team);
      if (managed === "1") {
        await expect(f.repos.setBotComputer(actor, "target", "team")).rejects.toThrow(
          "Workspace is busy",
        );
        expect(f.tx.bot.update).not.toHaveBeenCalled();
      } else {
        const result = await f.repos.setBotComputer(actor, "target", "team");
        expect(result.computerMode).toBe("team");
        expect(f.target.computerId).toBe("existing-team");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each(["managed", "codex"])("permits an owned Team destination in %s mode", async (mode) => {
  vi.stubEnv("TEAM_MANAGEMENT_ENABLED", mode === "managed" ? "1" : "0");
  vi.stubEnv("AGENT_RUNTIME", mode === "codex" ? "codex" : "scripted");
  try {
    const f = fixture();
    const result = await f.repos.setBotComputer(actor, "target", "team");
    expect(result.computerMode).toBe("team");
    expect(f.target.computerId).toBe("computer-team");
    expect(f.tx.checkpoint.create).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(["user", "space"])(
  "rejects a managed Team with a foreign attached Bot %s",
  async (kind) => {
    vi.stubEnv("TEAM_MANAGEMENT_ENABLED", "1");
    try {
      const f = fixture();
      f.source.computerId = "computer-team";
      if (kind === "user") f.source.userId = "other";
      if (kind === "space") f.source.spaceId = "other";
      await expect(f.repos.setBotComputer(actor, "target", "team")).rejects.toThrow(
        "Managed Team Computer contains another account's bots",
      );
      expect(f.tx.bot.update).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("lets an owner leave a legacy foreign-owned Team Computer for its own Private Computer", async () => {
  vi.stubEnv("TEAM_MANAGEMENT_ENABLED", "1");
  try {
    const f = fixture();
    f.target.computer = f.source.computer;
    f.target.computerId = f.source.computerId;
    f.source.computer.scope = "team";
    f.source.computer.userId = "another-member";
    const result = await f.repos.setBotComputer(actor, "target", "dedicated");
    expect(result.computerMode).toBe("dedicated");
    expect(f.target.computerId).toBe(f.ownComputer.id);
  } finally {
    vi.unstubAllEnvs();
  }
});

const newBot = {
  name: "New Bot",
  title: "",
  description: "",
  instructions: "new instructions",
  color: "ink",
  notifyOnFinish: true,
};

it("honors an explicit managed Team selection without creating a checkpoint", async () => {
  vi.stubEnv("TEAM_MANAGEMENT_ENABLED", "1");
  try {
    const f = fixture();
    const result = await f.repos.createBot(actor, { ...newBot, computerMode: "team" });
    expect(result.computerMode).toBe("team");
    expect(result.threadId).toBe("thread-target");
    expect(f.tx.computer.upsert).toHaveBeenCalledTimes(1);
    expect(f.tx.checkpoint.create).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps the unspecified managed default Private", async () => {
  vi.stubEnv("TEAM_MANAGEMENT_ENABLED", "1");
  try {
    const f = fixture();
    const result = await f.repos.createBot(actor, newBot);
    expect(result.computerMode).toBe("dedicated");
    expect(f.target.computerId).toBe(f.ownComputer.id);
    expect(f.tx.checkpoint.create).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(["owner", "attached-user", "attached-space"])(
  "refuses managed Team creation with a foreign %s before creating the Bot",
  async (kind) => {
    vi.stubEnv("TEAM_MANAGEMENT_ENABLED", "1");
    try {
      const f = fixture();
      if (kind === "owner")
        f.tx.computer.upsert.mockResolvedValue({
          ...f.ownComputer,
          id: "computer-team",
          scope: "team",
          userId: "other",
        });
      else {
        f.source.computerId = "computer-team";
        if (kind === "attached-user") f.source.userId = "other";
        else f.source.spaceId = "other";
      }
      await expect(f.repos.createBot(actor, { ...newBot, computerMode: "team" })).rejects.toThrow(
        "Managed Team Computer",
      );
      expect(f.tx.bot.create).not.toHaveBeenCalled();
      expect(f.tx.checkpoint.create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
