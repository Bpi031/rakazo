import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { destroyBot } from "./child-bots.js";

it("retains checkpoint artifact families and bytes while deleting unrelated personal artifacts", async () => {
  const context: AdapterContext = {
    operationId: "test",
    traceId: "test",
    spaceId: "space",
    userId: "owner",
    signal: new AbortController().signal,
  };
  const rows = [
    { id: "root", rootArtifactId: null, storageKey: "root-bytes" },
    { id: "saved-version", rootArtifactId: "root", storageKey: "saved-bytes" },
    { id: "later-version", rootArtifactId: "root", storageKey: "later-bytes" },
    { id: "unused", rootArtifactId: null, storageKey: "unused-bytes" },
    { id: "shared-storage", rootArtifactId: null, storageKey: "saved-bytes" },
    { id: "group-artifact", rootArtifactId: null, storageKey: "group-bytes", groupId: "group" },
    { id: "another-owner", rootArtifactId: null, storageKey: "other-bytes", userId: "other" },
  ].map((row) => ({
    botId: "bot" as string | null,
    spaceId: "space",
    userId: "owner",
    groupId: null as string | null,
    checkpointHidden: false,
    ...row,
  }));
  const bytes = new Set(rows.map((row) => row.storageKey));
  const snapshots = [
    { businessState: { artifacts: [{ id: "saved-version" }, { id: "another-owner" }] } },
  ];
  const inScope = (row: (typeof rows)[number], where: Record<string, unknown>) =>
    ["botId", "spaceId", "userId", "groupId"].every(
      (key) => !(key in where) || row[key as keyof typeof row] === where[key],
    );
  const query = vi.fn().mockResolvedValue([]);
  const findCheckpoints = vi.fn().mockResolvedValue(snapshots);
  const findArtifacts = vi.fn(async ({ where }) => rows.filter((row) => inScope(row, where)));
  const updateArtifacts = vi.fn(async ({ where, data }) => {
    for (const row of rows)
      if (inScope(row, where) && where.id.in.includes(row.id)) Object.assign(row, data);
    return { count: where.id.in.length };
  });
  const deleteArtifacts = vi.fn(async ({ where }) => {
    const deleted = rows.filter((row) => inScope(row, where) && !where.id?.notIn.includes(row.id));
    // Mirror the root FK's cascade so retaining only a version would fail this test.
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (deleted.some((root) => row.id === root.id || row.rootArtifactId === root.id))
        rows.splice(index, 1);
    }
    return { count: deleted.length };
  });
  const tx = {
    $queryRaw: query,
    checkpoint: { findMany: findCheckpoints },
    artifact: { findMany: findArtifacts, updateMany: updateArtifacts, deleteMany: deleteArtifacts },
    chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
    computerExecutionLease: { deleteMany: vi.fn() },
    computer: { updateMany: vi.fn() },
    botDeletion: { create: vi.fn() },
    bot: {
      delete: vi.fn(async () => {
        for (const row of rows) if (row.botId === "bot") row.botId = null;
      }),
    },
  };
  const prisma = {
    computer: { findUnique: vi.fn().mockResolvedValue(null) },
    run: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    routine: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  const remove = vi.fn(async (key: string) => {
    bytes.delete(key);
  });

  await destroyBot(
    {
      prisma,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      artifacts: { remove } as unknown as ArtifactStore,
    },
    { id: "bot", spaceId: "space", userId: "owner", name: "Synthetic", archivedAt: null },
    context,
    { deleteMemories: true },
  );

  expect(findCheckpoints).toHaveBeenCalledWith({
    where: { botId: "bot", spaceId: "space", userId: "owner" },
    select: { businessState: true },
  });
  expect(rows.map((row) => row.id)).toEqual([
    "root",
    "saved-version",
    "later-version",
    "group-artifact",
    "another-owner",
  ]);
  expect(rows.filter((row) => row.checkpointHidden).map((row) => row.id)).toEqual([
    "root",
    "saved-version",
    "later-version",
  ]);
  expect(rows.every((row) => row.botId === null)).toBe(true);
  expect(remove).toHaveBeenCalledExactlyOnceWith("unused-bytes", context);
  expect(bytes).toEqual(
    new Set(["root-bytes", "saved-bytes", "later-bytes", "group-bytes", "other-bytes"]),
  );
  expect(String(query.mock.calls[0]![0])).toContain("FROM threads");
  expect(String(query.mock.calls[1]![0])).toContain("FROM bots");
  expect(query.mock.invocationCallOrder[0]).toBeLessThan(
    findCheckpoints.mock.invocationCallOrder[0]!,
  );
});
