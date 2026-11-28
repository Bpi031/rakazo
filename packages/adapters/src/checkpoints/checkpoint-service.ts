import { createHash, randomUUID } from "node:crypto";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import type {
  Actor,
  CheckpointRollbackInput,
  CheckpointStatus,
  CheckpointView,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, callIdFromClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  assertCheckpointRestoreOwner,
  CheckpointConflictError,
  cancelRunsInTransaction,
  checkpointArtifactIds,
  checkpointMessageWhere,
  checkpointThreadLock,
  claimCheckpointWorkspace,
  createRepos,
  ensureCheckpointBranch,
  expireComputerExecutionLeases,
  IsolationError,
  Prisma,
  readJsonColumn,
  releaseCheckpointWorkspace,
  withCheckpointRestoreLock,
  writeBotInstructions,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { toComputerRef } from "../computers/screens/computer-support.js";
import { PriorityService } from "../policy/policy-priorities.js";
import type { CheckpointBusiness } from "../storage/checkpoint-state.js";
import {
  checkpointAuditSource,
  checkpointBusiness,
  checkpointBusinessOf,
  checkpointPromptMetadata,
  checkpointTranscript,
} from "../storage/checkpoint-state.js";
import { checkpointFileDiff, stateDigest } from "./checkpoint-digest.js";
import type { CheckpointFileScope } from "./checkpoint-files.js";
import { CheckpointFiles, checkpointFileManifestSchema } from "./checkpoint-files.js";
import { assertCheckpointWritersIdle, stopCheckpointWriters } from "./checkpoint-processes.js";

export { checkpointFileDiff } from "./checkpoint-digest.js";

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const txOptions = { maxWait: 10_000, timeout: 300_000 };
type CaptureInput = {
  runId: string;
  kind: "auto_pre_solve";
  reason: "rost_watch_observed";
};

function auditFileManifest(row: { id: string; fileManifest: unknown }) {
  return readJsonColumn(
    checkpointFileManifestSchema,
    row.fileManifest,
    {
      table: "checkpoints",
      column: "fileManifest",
      id: row.id,
    },
    "reject",
  );
}

function unavailableAttachments() {
  return new CheckpointConflictError("Saved checkpoint attachments are unavailable", "incomplete");
}

function savedAttachmentHashes(artifacts: CheckpointBusiness["artifacts"]) {
  if (!Array.isArray(artifacts)) throw unavailableAttachments();
  const expected = new Map<string, string | undefined>();
  for (const row of artifacts) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      expected.has(row.id) ||
      (row.hash !== undefined && (typeof row.hash !== "string" || !row.hash))
    )
      throw unavailableAttachments();
    expected.set(row.id, row.hash);
  }
  return expected;
}

async function assertSavedAttachments(
  tx: Prisma.TransactionClient,
  scope: { botId: string; groupId: null; spaceId: string; userId: string },
  expected: Map<string, string | undefined>,
) {
  if (expected.size === 0) return;
  const rows = await tx.artifact.findMany({
    where: { ...scope, id: { in: [...expected.keys()] } },
    select: { id: true, hash: true },
  });
  // A storage key may change during a storage migration; the pinned content digest may not.
  if (
    rows.length !== expected.size ||
    rows.some(
      (row) =>
        !expected.has(row.id) ||
        (expected.get(row.id) !== undefined && expected.get(row.id) !== row.hash),
    )
  )
    throw unavailableAttachments();
}

function workspaceCheckpoints(
  threadId: string,
  workspaceKey: string,
  scope: CheckpointFileScope,
): Prisma.CheckpointWhereInput {
  // Older snapshots predate Team roots; their unbound manifests are dedicated only.
  return scope === "team"
    ? { threadId, workspaceKey }
    : { threadId, OR: [{ workspaceKey }, { workspaceKey: null }] };
}

function checkpointRevision(
  generation: number,
  blocked: boolean,
  workspaceKey: string,
  latest?: string,
) {
  return `${generation}:${blocked}:${workspaceKey}:${latest ?? ""}`;
}

/** V1: serial synchronous recovery. A failed restore leaves the thread blocked. */
export class CheckpointService {
  private files: CheckpointFiles;
  private priorities: PriorityService;
  constructor(private deps: { prisma: PrismaClient; sandbox: SandboxProvider; dataDir: string }) {
    this.files = new CheckpointFiles(deps);
    this.priorities = new PriorityService(deps);
  }

  private async owned(
    actor: Actor,
    botId: string,
    db: Pick<PrismaClient, "bot" | "thread"> = this.deps.prisma,
  ) {
    const bot = await db.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      include: { thread: true, computer: true },
    });
    if (!bot) throw new IsolationError();
    if (
      !bot.computer ||
      (bot.computer.scope !== "dedicated" && bot.computer.scope !== "team") ||
      bot.computer.userId !== actor.userId ||
      bot.computer.spaceId !== actor.spaceId ||
      bot.computer.state !== "running" ||
      !bot.computer.providerRef
    ) {
      throw new CheckpointConflictError("Checkpoints require a running owned workspace");
    }
    const thread = await db.thread.findFirstOrThrow({
      where: { botId, spaceId: actor.spaceId, userId: actor.userId },
    });
    const scope: CheckpointFileScope = bot.computer.scope === "team" ? "team" : "dedicated";
    const workspaceKey = createHash("sha256")
      .update(
        JSON.stringify([
          actor.spaceId,
          actor.userId,
          bot.computer.id,
          bot.computer.homeKey,
          scope === "team" ? `team/bots/${botId}` : "workspace",
        ]),
      )
      .digest("hex");
    return {
      bot,
      thread,
      computer: toComputerRef(bot.computer),
      computerId: bot.computer.id,
      workspaceKey,
      scope,
      workspaceBlocked: bot.computer.maintenanceId?.startsWith("checkpoint-restore:") === true,
    };
  }

  async status(actor: Actor, botId: string): Promise<CheckpointStatus> {
    return this.readStatus(actor, botId, this.deps.prisma);
  }

  private async readStatus(
    actor: Actor,
    botId: string,
    db: Pick<Prisma.TransactionClient, "bot" | "thread" | "checkpoint">,
  ): Promise<CheckpointStatus> {
    const {
      thread,
      workspaceKey,
      scope = "dedicated",
      workspaceBlocked = false,
    } = await this.owned(actor, botId, db);
    const blocked = thread.checkpointBlocked || workspaceBlocked;
    const latest = await db.checkpoint.findFirst({
      where: workspaceCheckpoints(thread.id, workspaceKey, scope),
      select: { id: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return {
      generation: thread.checkpointGeneration,
      blocked,
      revision: checkpointRevision(thread.checkpointGeneration, blocked, workspaceKey, latest?.id),
    };
  }

  async list(actor: Actor, botId: string): Promise<CheckpointView> {
    const {
      thread,
      workspaceKey,
      scope = "dedicated",
      workspaceBlocked = false,
    } = await this.owned(actor, botId);
    const blocked = thread.checkpointBlocked || workspaceBlocked;
    const [rows, audits, branches] = await Promise.all([
      this.deps.prisma.checkpoint.findMany({
        where: workspaceCheckpoints(thread.id, workspaceKey, scope),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.deps.prisma.rollbackAuditLog.findMany({
        where: { threadId: thread.id, status: "completed" },
        orderBy: { createdAt: "desc" },
      }),
      this.deps.prisma.conversationBranch.findMany({ where: { threadId: thread.id } }),
    ]);
    const origins = new Map(audits.map((audit) => [audit.branchId, audit.toCheckpointId]));
    const previous = new Map<string, string>();
    const aliases = new Map<string, string>();
    const ordered = [...rows].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const states = new Map<string, (typeof rows)[number]>();
    const names = new Map<string, string>();
    const manualStates = new Set<string>();
    const signatures = new Map<string, string>();
    for (const row of ordered) {
      const digest = stateDigest(row.fileManifest, checkpointBusinessOf(row));
      signatures.set(row.id, digest);
      if (!states.has(digest)) states.set(digest, row);
      if (row.label?.trim()) names.set(digest, row.label);
      if (row.kind === "manual") manualStates.add(digest);
    }
    for (const row of ordered) aliases.set(row.id, states.get(signatures.get(row.id)!)!.id);
    const parents = new Map<string, string | null>();
    const nodes = ordered.flatMap((row) => {
      const business = checkpointBusinessOf(row);
      const parentCheckpointId =
        business.parentCheckpointId ??
        previous.get(row.branchId) ??
        origins.get(row.branchId) ??
        null;
      parents.set(row.id, parentCheckpointId);
      previous.set(row.branchId, row.id);
      if (aliases.get(row.id) !== row.id) return [];
      const digest = signatures.get(row.id)!;
      return [
        {
          id: row.id,
          kind: (manualStates.has(digest)
            ? "manual"
            : row.kind) as CheckpointView["checkpoints"][number]["kind"],
          label: names.get(digest) ?? row.label ?? null,
          branchId: row.branchId,
          createdAt: row.createdAt.toISOString(),
          parentCheckpointId,
          ...checkpointPromptMetadata(business),
        },
      ];
    });
    const resolve = (id: string | null | undefined) => (id ? (aliases.get(id) ?? null) : null);
    for (const node of nodes) {
      let parent = node.parentCheckpointId;
      const seen = new Set<string>([node.id]);
      while (parent && resolve(parent) === node.id && !seen.has(parent)) {
        seen.add(parent);
        parent = parents.get(parent) ?? null;
      }
      node.parentCheckpointId = resolve(parent) === node.id ? null : resolve(parent);
    }
    const used = new Map<string, number>();
    for (const row of rows)
      used.set(row.branchId, Math.max(used.get(row.branchId) ?? 0, row.createdAt.getTime()));
    for (const audit of audits) {
      const time = audit.createdAt.getTime();
      const from = checkpointAuditSource(audit);
      for (const id of [audit.branchId, from])
        if (id) used.set(id, Math.max(used.get(id) ?? 0, time));
    }
    return {
      generation: thread.checkpointGeneration,
      blocked,
      revision: checkpointRevision(thread.checkpointGeneration, blocked, workspaceKey, rows[0]?.id),
      activeBranchId: thread.activeBranchId,
      currentCheckpointId: resolve(
        thread.activeBranchId
          ? (previous.get(thread.activeBranchId) ?? origins.get(thread.activeBranchId))
          : null,
      ),
      checkpoints: nodes,
      branches: branches.map((branch) => ({
        id: branch.id,
        parentCheckpointId: resolve(origins.get(branch.id)),
        lastUsedAt: new Date(used.get(branch.id) ?? branch.createdAt?.getTime() ?? 0).toISOString(),
      })),
    };
  }

  private async anchor(
    tx: Prisma.TransactionClient,
    threadId: string,
    branchId: string,
    workspaceKey: string,
    scope: CheckpointFileScope,
  ) {
    const workspace = workspaceCheckpoints(threadId, workspaceKey, scope);
    const own = await tx.checkpoint.findFirst({
      where: { ...workspace, branchId },
      orderBy: { createdAt: "desc" },
    });
    if (own) return own;
    const origin = await tx.rollbackAuditLog.findFirst({
      where: { threadId, branchId, status: "completed" },
      orderBy: { createdAt: "desc" },
    });
    return origin
      ? tx.checkpoint.findFirst({ where: { ...workspace, id: origin.toCheckpointId } })
      : null;
  }

  private async capture(
    tx: Prisma.TransactionClient,
    actor: Actor,
    botId: string,
    threadId: string,
    kind: string,
    label?: string,
    reason?: string,
    taskState?: unknown,
    expectedWorkspaceKey?: string,
  ) {
    const { computer, workspaceKey, scope = "dedicated" } = await this.owned(actor, botId, tx);
    if (expectedWorkspaceKey && workspaceKey !== expectedWorkspaceKey)
      throw new CheckpointConflictError("Workspace binding changed during checkpointing", "stale");
    const thread = await tx.thread.findUniqueOrThrow({ where: { id: threadId } });
    if (!thread.activeBranchId) throw new Error("Missing checkpoint branch");
    const fileManifest = await this.files.capture(actor, botId, computer, scope);
    const binding = await this.priorities.captureCheckpointBinding(actor, botId, tx);
    const artifacts = await tx.artifact.findMany({
      where: {
        botId,
        groupId: null,
        spaceId: actor.spaceId,
        userId: actor.userId,
        checkpointHidden: false,
      },
      select: { id: true, hash: true, storageKey: true },
    });
    // Messages can be updated in place by streaming and question answers. Freeze their
    // content, not just their sequence boundary, before later turns can mutate it.
    const transcript = await tx.message.findMany({
      where: await checkpointMessageWhere(tx, threadId),
      orderBy: { seq: "asc" },
      select: {
        id: true,
        seq: true,
        role: true,
        blocks: true,
        botId: true,
        authorUserId: true,
        runId: true,
        clientNonce: true,
        replyToMessageId: true,
        replyQuote: true,
        createdAt: true,
      },
    });
    const bot = await tx.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { instructions: true },
    });
    const anchor = await this.anchor(tx, threadId, thread.activeBranchId, workspaceKey, scope);
    const business = checkpointBusiness.parse({
      binding,
      artifacts,
      transcript: checkpointTranscript.parse(json(transcript)),
      botInstructions: bot.instructions,
    });
    if (
      kind === "auto_pre_rollback" &&
      anchor &&
      anchor.workspaceKey === workspaceKey &&
      !(Array.isArray(taskState) && taskState.length) &&
      stateDigest(fileManifest, business) ===
        stateDigest(anchor.fileManifest, checkpointBusinessOf(anchor))
    )
      return anchor;
    return tx.checkpoint.create({
      data: {
        threadId,
        botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        workspaceKey,
        branchId: thread.activeBranchId,
        kind,
        label,
        generation: thread.checkpointGeneration,
        cutoffMessageSeq: thread.nextMessageSeq - 1,
        cutoffEventSeq: thread.nextEventSeq - 1,
        fileManifest: json(fileManifest),
        businessState: json({
          ...business,
          parentCheckpointId: anchor?.id ?? null,
          reason,
          restoreMode: "reconstructed",
          workspaceScope: scope,
        }),
        taskState: json(
          taskState ??
            (await tx.run.findMany({
              where: { threadId, status: { in: [...ACTIVE_RUN_STATUSES] } },
              select: { id: true, status: true, trigger: true },
            })),
        ),
      },
    });
  }

  async create(actor: Actor, input: { botId: string; label?: string; expectedGeneration: number }) {
    const {
      thread,
      computer,
      computerId,
      workspaceKey,
      scope = "dedicated",
    } = await this.owned(actor, input.botId);
    const owner = `checkpoint-save:${randomUUID()}`;
    await claimCheckpointWorkspace(this.deps.prisma, {
      computerId,
      ...actor,
      botId: input.botId,
      owner,
    });
    try {
      await assertCheckpointWritersIdle(
        this.deps.sandbox,
        computer,
        {
          ...actor,
          botId: input.botId,
          operationId: owner,
          traceId: "checkpoint-idle",
          signal: AbortSignal.timeout(20_000),
        },
        scope,
      );
      return await this.deps.prisma.$transaction(async (tx) => {
        await checkpointThreadLock(tx, thread.id);
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
        const current = await ensureCheckpointBranch(tx, thread.id);
        if (current.checkpointBlocked || current.checkpointGeneration !== input.expectedGeneration)
          throw new CheckpointConflictError("Workspace changed; refresh checkpoints", "stale");
        if (
          await tx.run.count({
            where: { threadId: thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
          })
        )
          throw new CheckpointConflictError("Wait for the current turn to finish before saving");
        if (
          await tx.routine.count({
            where: { botId: input.botId, active: true, jobWatch: { not: Prisma.JsonNull } },
          })
        )
          throw new CheckpointConflictError("Stop the watched job before saving");
        return this.capture(
          tx,
          actor,
          input.botId,
          thread.id,
          "manual",
          input.label,
          undefined,
          undefined,
          workspaceKey,
        );
      }, txOptions);
    } finally {
      await releaseCheckpointWorkspace(this.deps.prisma, computerId, owner);
    }
  }

  async captureForRun(input: CaptureInput) {
    try {
      const run = await this.deps.prisma.run.findUniqueOrThrow({ where: { id: input.runId } });
      const actor: Actor = {
        userId: run.userId,
        spaceId: run.spaceId,
        email: "",
        isDeploymentOwner: false,
      };
      const {
        thread,
        computer,
        computerId,
        workspaceKey,
        scope = "dedicated",
      } = await this.owned(actor, run.botId);
      const owner = `checkpoint-save:${randomUUID()}`;
      await claimCheckpointWorkspace(this.deps.prisma, {
        computerId,
        ...actor,
        botId: run.botId,
        owner,
        allowedRunId: run.id,
      });
      try {
        await assertCheckpointWritersIdle(
          this.deps.sandbox,
          computer,
          {
            ...actor,
            botId: run.botId,
            operationId: owner,
            traceId: "checkpoint-idle",
            signal: AbortSignal.timeout(20_000),
          },
          scope,
        );
        await this.deps.prisma.$transaction(async (tx) => {
          await checkpointThreadLock(tx, thread.id);
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
          const current = await ensureCheckpointBranch(tx, thread.id);
          if (
            current.checkpointBlocked ||
            current.checkpointGeneration !== run.checkpointGeneration
          )
            throw new Error("Checkpoint generation changed");
          await this.capture(
            tx,
            actor,
            run.botId,
            thread.id,
            input.kind,
            undefined,
            input.reason,
            undefined,
            workspaceKey,
          );
        }, txOptions);
      } finally {
        await releaseCheckpointWorkspace(this.deps.prisma, computerId, owner);
      }
    } catch (error) {
      // Automatic observations must not cancel an already-started job or its watch.
      // Incomplete/unstable captures never create a selectable checkpoint.
      getLogger().error("Automatic checkpoint skipped", error);
    }
  }

  async rollback(actor: Actor, input: CheckpointRollbackInput) {
    const {
      thread,
      computerId,
      workspaceKey,
      scope = "dedicated",
    } = await this.owned(actor, input.botId);
    const target = await this.deps.prisma.checkpoint.findFirst({
      where: {
        id: input.checkpointId,
        threadId: thread.id,
        botId: input.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
      },
    });
    if (!target) throw new IsolationError();
    if (
      target.workspaceKey !== workspaceKey &&
      (target.workspaceKey !== null || scope !== "dedicated")
    )
      throw new CheckpointConflictError("Checkpoint belongs to a different workspace", "stale");
    const owner = `checkpoint-restore:${randomUUID()}`;
    const restore = async () => {
      await claimCheckpointWorkspace(this.deps.prisma, {
        computerId,
        ...actor,
        botId: input.botId,
        owner,
        restore: true,
        retry: { threadId: thread.id, expectedGeneration: input.expectedGeneration },
        restoreJournal: {
          checkpointId: target.id,
          branchId: target.branchId,
          assertConfirmed: async (tx) => {
            const current = await this.readStatus(actor, input.botId, tx);
            if (
              current.generation !== input.expectedGeneration ||
              current.revision !== input.expectedRevision
            )
              throw new CheckpointConflictError("Workspace changed; refresh checkpoints", "stale");
          },
        },
      });
      let release = false;
      try {
        const result = await this.rollbackClaimed(actor, input, workspaceKey, {
          owner,
          computerId,
        });
        release = result.ok;
        return result;
      } catch (error) {
        const state = await this.deps.prisma.thread.findUnique({
          where: { id: thread.id },
          select: { checkpointBlocked: true, checkpointGeneration: true, activeBranchId: true },
        });
        release = state?.checkpointBlocked !== true;
        if (!release && state) {
          // Covers failures before rollbackClaimed's filesystem phase, including a
          // rejected retry. Once this audit commits, this attempt performs no more I/O.
          await this.deps.prisma.rollbackAuditLog.create({
            data: {
              threadId: thread.id,
              botId: input.botId,
              spaceId: actor.spaceId,
              userId: actor.userId,
              toCheckpointId: target.id,
              branchId: state.activeBranchId ?? target.branchId,
              generation: state.checkpointGeneration,
              status: "failed",
              details: json({
                restoreMode: "reconstructed",
                error: error instanceof Error ? error.message : "Recovery failed",
                workspaceMaintenanceOwner: owner,
                workspaceComputerId: computerId,
              }),
            },
          });
        }
        throw error;
      } finally {
        if (release) await releaseCheckpointWorkspace(this.deps.prisma, computerId, owner);
      }
    };
    return withCheckpointRestoreLock(this.deps.prisma, computerId, restore);
  }

  private async rollbackClaimed(
    actor: Actor,
    input: { botId: string; checkpointId: string; expectedGeneration: number },
    expectedWorkspaceKey: string,
    maintenance: { owner: string; computerId: string },
  ) {
    const {
      thread,
      computer,
      workspaceKey,
      scope = "dedicated",
    } = await this.owned(actor, input.botId);
    if (workspaceKey !== expectedWorkspaceKey)
      throw new CheckpointConflictError("Workspace binding changed during checkpointing", "stale");
    const target = await this.deps.prisma.checkpoint.findFirst({
      where: { id: input.checkpointId, threadId: thread.id, userId: actor.userId },
    });
    if (!target) throw new IsolationError();
    const business = checkpointBusinessOf(target);
    const attachments = savedAttachmentHashes(business.artifacts);
    const artifactScope = {
      botId: input.botId,
      groupId: null,
      spaceId: actor.spaceId,
      userId: actor.userId,
    };
    // Commit the fence before filesystem work so workers on other connections see it.
    const preparation = await this.deps.prisma.$transaction(async (tx) => {
      await checkpointThreadLock(tx, thread.id);
      await assertCheckpointRestoreOwner(tx, maintenance.computerId, maintenance.owner);
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
      const current = await ensureCheckpointBranch(tx, thread.id);
      if (current.checkpointGeneration !== input.expectedGeneration)
        throw new CheckpointConflictError("Workspace changed; refresh checkpoints", "stale");
      await assertSavedAttachments(tx, artifactScope, attachments);
      const tasks = await tx.run.findMany({
        where: { threadId: thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: {
          id: true,
          taskId: true,
          status: true,
          trigger: true,
          userId: true,
          spaceId: true,
        },
      });
      await cancelRunsInTransaction(tx, tasks, new Date());
      await tx.routine.updateMany({
        where: { botId: input.botId, spaceId: actor.spaceId },
        data: { active: false, nextRunAt: null },
      });
      const updated = await tx.thread.update({
        where: { id: thread.id },
        data: { checkpointGeneration: { increment: 1 }, checkpointBlocked: true },
      });
      return { generation: updated.checkpointGeneration, branchId: current.activeBranchId, tasks };
    }, txOptions);
    let rescueId: string | undefined;
    try {
      await stopCheckpointWriters(
        this.deps.sandbox,
        computer,
        {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: input.botId,
          operationId: randomUUID(),
          traceId: "checkpoint-stop",
          signal: AbortSignal.timeout(20_000),
        },
        scope,
      );
      // Commit the rescue before changing files: a later SQL failure must not erase it.
      const rescue = await this.deps.prisma.$transaction(async (tx) => {
        await checkpointThreadLock(tx, thread.id);
        await assertCheckpointRestoreOwner(tx, maintenance.computerId, maintenance.owner);
        const current = await tx.thread.findUniqueOrThrow({ where: { id: thread.id } });
        if (current.checkpointGeneration !== preparation.generation)
          throw new Error("Recovery was superseded");
        const cancelledIds = preparation.tasks.map((task) => task.id);
        if (cancelledIds.length)
          await expireComputerExecutionLeases(tx, { runId: { in: cancelledIds } });
        return this.capture(
          tx,
          actor,
          input.botId,
          thread.id,
          "auto_pre_rollback",
          undefined,
          "rollback",
          preparation.tasks,
          expectedWorkspaceKey,
        );
      }, txOptions);
      rescueId = rescue.id;
      return await this.deps.prisma.$transaction(async (tx) => {
        await checkpointThreadLock(tx, thread.id);
        await assertCheckpointRestoreOwner(tx, maintenance.computerId, maintenance.owner);
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
        const current = await tx.thread.findUniqueOrThrow({ where: { id: thread.id } });
        if (current.checkpointGeneration !== preparation.generation)
          throw new Error("Recovery was superseded");
        await tx.artifact.updateMany({
          where: artifactScope,
          data: { checkpointHidden: true },
        });
        if (attachments.size) {
          const visible = await tx.artifact.updateMany({
            where: { ...artifactScope, id: { in: [...attachments.keys()] } },
            data: { checkpointHidden: false },
          });
          if (visible.count !== attachments.size) throw unavailableAttachments();
          await assertSavedAttachments(tx, artifactScope, attachments);
        }
        await this.files.restore(
          actor,
          input.botId,
          computer,
          target.fileManifest,
          scope,
          preparation.generation,
        );
        await this.priorities.restoreCheckpointBinding(actor, input.botId, business.binding, tx);
        // Parent links remain for audit; the complete frozen transcript replaces the
        // live ancestor rows, which may since have changed. Global sequences never rewind.
        const branch = await tx.conversationBranch.create({
          data: {
            threadId: thread.id,
            parentBranchId: target.branchId,
            parentCutoffMessageSeq: -1,
            parentCutoffEventSeq: -1,
          },
        });
        const updated = await tx.thread.update({
          where: { id: thread.id },
          data: {
            activeBranchId: branch.id,
            nextMessageSeq: { increment: business.transcript.length },
            historyCompactionGeneration: { increment: 1 },
            historyCompactedUpToSeq: null,
            historyCompactionSummary: null,
            checkpointBlocked: false,
          },
        });
        const firstSeq = updated.nextMessageSeq - business.transcript.length;
        const messageIds = new Map(
          business.transcript.map((message) => [message.id, randomUUID()]),
        );
        if (business.transcript.length)
          await tx.message.createMany({
            data: business.transcript.map((message, index) => {
              const callId = callIdFromClientNonce(message.clientNonce);
              return {
                id: messageIds.get(message.id)!,
                threadId: thread.id,
                branchId: branch.id,
                seq: firstSeq + index,
                role: message.role,
                blocks: message.blocks,
                botId: message.botId,
                authorUserId: message.authorUserId ?? null,
                runId: message.runId,
                // The original nonce remains reserved for retry idempotency. Only
                // voice grouping survives under a fresh, unique message nonce.
                clientNonce: callId ? `call:${callId}:${randomUUID()}` : undefined,
                replyToMessageId: message.replyToMessageId
                  ? (messageIds.get(message.replyToMessageId) ?? null)
                  : null,
                replyQuote: message.replyQuote,
                createdAt: new Date(message.createdAt),
              };
            }),
          });
        await writeBotInstructions(tx, {
          botId: input.botId,
          instructions: business.botInstructions,
          reason: "Checkpoint restore",
        });
        await tx.rollbackAuditLog.create({
          data: {
            threadId: thread.id,
            botId: input.botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            fromCheckpointId: rescue.id,
            toCheckpointId: target.id,
            rescueCheckpointId: rescue.id,
            branchId: branch.id,
            generation: preparation.generation,
            status: "completed",
            details: json({
              operation: "rollback",
              rescueReused:
                rescue.kind !== "auto_pre_rollback" ||
                rescue.branchId !== preparation.branchId ||
                rescue.generation !== preparation.generation,
              restoreMode: "reconstructed",
              fromBranchId: preparation.branchId,
              targetBranchId: target.branchId,
              cutoffMessageSeq: target.cutoffMessageSeq,
              cancelledTasks: preparation.tasks,
              files: checkpointFileDiff(auditFileManifest(rescue), auditFileManifest(target)),
              rulesBefore: checkpointBusinessOf(rescue).binding,
              rulesAfter: business.binding,
              solveStarted: false,
            }),
          },
        });
        return {
          ok: true as const,
          generation: preparation.generation,
          branchId: branch.id,
          rescueCheckpointId: rescue.id,
        };
      }, txOptions);
    } catch (error) {
      // Use a fresh transaction: PostgreSQL SQL errors abort the original transaction.
      await this.deps.prisma.$transaction(async (tx) => {
        await checkpointThreadLock(tx, thread.id);
        await tx.thread.updateMany({
          where: { id: thread.id, checkpointGeneration: preparation.generation },
          data: { checkpointBlocked: true },
        });
        await tx.rollbackAuditLog.create({
          data: {
            threadId: thread.id,
            botId: input.botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            fromCheckpointId: rescueId,
            toCheckpointId: target.id,
            rescueCheckpointId: rescueId,
            branchId: preparation.branchId,
            generation: preparation.generation,
            status: "failed",
            details: json({
              restoreMode: "reconstructed",
              error: error instanceof Error ? error.message : "Recovery failed",
              workspaceMaintenanceOwner: maintenance.owner,
              workspaceComputerId: maintenance.computerId,
              cancelledTasks: preparation.tasks,
            }),
          },
        });
      }, txOptions);
      return {
        ok: false as const,
        error: "Recovery failed. Workspace is blocked; retry a saved checkpoint.",
        generation: preparation.generation,
      };
    }
  }

  async audit(actor: Actor, botId: string) {
    const scope = { spaceId: actor.spaceId, userId: actor.userId, botId };
    // Research snapshots outlive the bot and its thread. Scope the archive itself;
    // reading it must not require a live workspace or a replacement bot.
    const checkpoints = await this.deps.prisma.checkpoint.findMany({
      where: scope,
      orderBy: { createdAt: "asc" },
    });
    const threadIds = [...new Set(checkpoints.map((checkpoint) => checkpoint.threadId))];
    if (threadIds.length === 0) {
      const bot = await createRepos(this.deps.prisma).getBot(actor, botId, {
        includeArchived: true,
      });
      if (bot.thread) threadIds.push(bot.thread.id);
    }
    const [audits, branches, messages, artifacts] = await Promise.all([
      this.deps.prisma.rollbackAuditLog.findMany({
        where: { ...scope, status: { not: "claimed" } },
        orderBy: { createdAt: "asc" },
      }),
      this.deps.prisma.conversationBranch.findMany({
        where: { threadId: { in: threadIds } },
      }),
      this.deps.prisma.message.findMany({
        where: { threadId: { in: threadIds } },
        orderBy: { seq: "asc" },
      }),
      this.deps.prisma.artifact.findMany({
        where: {
          id: { in: checkpointArtifactIds(checkpoints) },
          spaceId: actor.spaceId,
          userId: actor.userId,
          groupId: null,
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      schema: "rakazo/checkpoint-audit/v1",
      restoreMode: "reconstructed",
      exportedAt: new Date().toISOString(),
      audits,
      checkpoints,
      branches,
      messages,
      artifacts,
    };
  }
}
