import { describe, expect, it, vi } from "vitest";
import {
  assertCheckpointGeneration,
  checkpointMessageWhere,
  checkpointRunFields,
  resolveCheckpointSegments,
} from "./checkpoints.js";
import type { Prisma, PrismaClient } from "./client.js";
import { assertRunCanWriteHistory, createThreadMessageInTransaction } from "./messages.js";

const branches = [
  { id: "A", parentBranchId: null, parentCutoffMessageSeq: null, parentCutoffEventSeq: null },
  { id: "B", parentBranchId: "A", parentCutoffMessageSeq: 10, parentCutoffEventSeq: 20 },
  { id: "C", parentBranchId: "A", parentCutoffMessageSeq: 5, parentCutoffEventSeq: 8 },
  { id: "D", parentBranchId: "B", parentCutoffMessageSeq: 14, parentCutoffEventSeq: 24 },
];

describe("checkpoint branches", () => {
  it("composes ancestry cutoffs without exposing abandoned siblings", () => {
    expect(resolveCheckpointSegments(branches, "D")).toEqual([
      { branchId: "D", messageSeq: null, eventSeq: null },
      { branchId: "B", messageSeq: 14, eventSeq: 24 },
      { branchId: "A", messageSeq: 10, eventSeq: 20 },
    ]);
    expect(resolveCheckpointSegments(branches, "C")).toEqual([
      { branchId: "C", messageSeq: null, eventSeq: null },
      { branchId: "A", messageSeq: 5, eventSeq: 8 },
    ]);
    // Undo branches from the rescue node on B, not from C's shorter ancestry.
    expect(resolveCheckpointSegments(branches, "B").map((segment) => segment.branchId)).toEqual([
      "B",
      "A",
    ]);
  });

  it("rejects missing and cyclic ancestry rather than showing unrestricted history", () => {
    expect(() => resolveCheckpointSegments(branches, "missing")).toThrow("missing");
    expect(() =>
      resolveCheckpointSegments(
        [{ id: "A", parentBranchId: "A", parentCutoffMessageSeq: 3, parentCutoffEventSeq: 4 }],
        "A",
      ),
    ).toThrow("ancestry");
  });

  it("generates a predicate that allows new messages after the historical cutoff", async () => {
    const db = {
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ activeBranchId: "C" }) },
      conversationBranch: { findMany: vi.fn().mockResolvedValue(branches) },
    };
    expect(await checkpointMessageWhere(db as unknown as PrismaClient, "thread")).toEqual({
      threadId: "thread",
      OR: [{ branchId: "C" }, { branchId: "A", seq: { lte: 5 } }],
    });
  });

  it("rejects stale runs even when they still report running", async () => {
    const db = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          status: "running",
          startedAt: null,
          checkpointGeneration: 1,
          thread: { checkpointGeneration: 2, checkpointBlocked: false },
        }),
      },
    };
    await expect(
      assertRunCanWriteHistory(db as unknown as Prisma.TransactionClient, "run"),
    ).rejects.toThrow("Run cannot write");
  });

  it("blocks normal messages while recovery needs attention", async () => {
    const tx = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValue({ nextMessageSeq: 42, activeBranchId: "C", checkpointBlocked: true }),
      },
      message: { create: vi.fn() },
    };
    await expect(
      createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
        threadId: "thread",
        role: "user",
        blocks: [{ kind: "text", text: "continue" }],
      }),
    ).rejects.toThrow("Workspace changed");
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("requires both matching generation and an available workspace", async () => {
    const db = {
      thread: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ checkpointGeneration: 3, checkpointBlocked: false }),
      },
    };
    await expect(
      assertCheckpointGeneration(db as unknown as PrismaClient, "thread", 2),
    ).rejects.toThrow();
    await expect(
      assertCheckpointGeneration(db as unknown as PrismaClient, "thread", 3),
    ).resolves.toBeUndefined();
    db.thread.findUnique.mockResolvedValue({ checkpointGeneration: 3, checkpointBlocked: true });
    await expect(
      assertCheckpointGeneration(db as unknown as PrismaClient, "thread", 3),
    ).rejects.toThrow();
  });

  it("binds new runs to the restored generation without changing old runs", async () => {
    const update = vi.fn().mockResolvedValue({
      activeBranchId: "restored-branch",
      checkpointGeneration: 4,
      checkpointBlocked: false,
    });
    const tx = { thread: { update }, run: { update: vi.fn(), updateMany: vi.fn() } };
    expect(await checkpointRunFields(tx as unknown as Prisma.TransactionClient, "thread")).toEqual({
      branchId: "restored-branch",
      checkpointGeneration: 4,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "thread" },
        data: { checkpointGeneration: { increment: 0 } },
      }),
    );
    expect(tx.run.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("refuses new runs while the workspace is blocked", async () => {
    const tx = {
      thread: {
        update: vi.fn().mockResolvedValue({
          activeBranchId: "restored-branch",
          checkpointGeneration: 4,
          checkpointBlocked: true,
        }),
      },
    };
    await expect(
      checkpointRunFields(tx as unknown as Prisma.TransactionClient, "thread"),
    ).rejects.toThrow("Workspace changed");
  });
});
