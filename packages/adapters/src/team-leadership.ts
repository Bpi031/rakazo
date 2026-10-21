import type { Actor } from "@rakazo/contracts";
import {
  leadershipProposal,
  leadershipToolInput,
  workflowDefinitionSchema,
} from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type Prisma,
  type PrismaClient,
} from "@rakazo/db";
import { managerRole, teamDigest } from "./team-policy.js";
import { memberScope } from "./team-storage.js";
import { observeTeamComputers } from "./team-observer.js";
import { TeamWorkflowService } from "./team-workflows.js";

const owner = (role: string) => role.split(",").some((r) => r.trim() === "owner");
type Tx = Prisma.TransactionClient;
export class TeamLeadershipService {
  constructor(
    private db: PrismaClient,
    private observe = observeTeamComputers,
  ) {}
  private async snapshot(
    actor: Actor,
    fromBotId: string,
    toBotId: string,
    workflowIds: string[],
    db: PrismaClient | Tx = this.db,
  ) {
    const scope = await memberScope(db as PrismaClient, actor.userId, actor.spaceId);
    if (!managerRole(scope.role) || new Set(workflowIds).size !== workflowIds.length)
      throw new Error("Current manager and distinct workflows required");
    const from = await db.bot.findFirstOrThrow({
      where: { id: fromBotId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
      include: { thread: true },
    });
    const to = await db.bot.findFirstOrThrow({
      where: { id: toBotId, archivedAt: null, space: { organizationId: scope.organizationId } },
      include: { thread: true, computer: true },
    });
    if (to.userId === actor.userId || !from.thread || !to.thread || to.computer?.scope === "team")
      throw new Error("Successor needs a distinct active private bot");
    const target = await memberScope(db as PrismaClient, to.userId, to.spaceId);
    const workflows = [];
    for (const id of workflowIds) {
      const flow = await db.teamWorkflow.findFirstOrThrow({
        where: { id, organizationId: scope.organizationId, managerUserId: actor.userId },
      });
      const definition = workflowDefinitionSchema.parse(flow.definition);
      if (definition.participants.some((p) => p.botId === to.id))
        throw new Error("Successor bot is a participant; draft a separate revised flow instead");
      workflows.push({ id, digest: flow.digest, status: flow.status, definition });
    }
    return {
      organizationId: scope.organizationId,
      fromUserId: actor.userId,
      toUserId: to.userId,
      fromBotId: from.id,
      toBotId: to.id,
      fromSpaceId: from.spaceId,
      toSpaceId: to.spaceId,
      fromThreadId: from.thread.id,
      toThreadId: to.thread.id,
      fromName: from.name,
      toName: to.name,
      fromRole: scope.role,
      toRole: target.role,
      fromControlVersion: scope.control?.version ?? 0,
      toControlVersion: target.control?.version ?? 0,
      workflows,
    };
  }
  async propose(actor: Actor, fromBotId: string, raw: unknown, key: string) {
    const input = leadershipProposal.parse(raw);
    const snapshot = await this.snapshot(actor, fromBotId, input.successorBotId, input.workflowIds);
    const id = teamDigest({ actor: actor.userId, key });
    const existing = await this.db.teamLeadershipTransfer.findUnique({ where: { id } });
    if (
      !existing &&
      (await this.db.teamLeadershipTransfer.count({
        where: { organizationId: snapshot.organizationId, fromUserId: actor.userId },
      })) >= 50
    )
      throw new Error("Handover inventory capacity reached");
    const expiresAt = existing?.expiresAt ?? new Date(Date.now() + 86400_000);
    const digest = teamDigest({ snapshot, expiresAt: expiresAt.toISOString() });
    if (existing && existing.digest !== digest) throw new Error("Handover changed during replay");
    const row =
      existing ??
      (await this.db.teamLeadershipTransfer.create({
        data: {
          id,
          organizationId: snapshot.organizationId,
          fromUserId: actor.userId,
          toUserId: snapshot.toUserId,
          fromBotId,
          toBotId: snapshot.toBotId,
          snapshot: snapshot as Prisma.InputJsonValue,
          digest,
          expiresAt,
        },
      }));
    return { id, digest, status: row.status, reviewUrl: `/app/${fromBotId}?workflows=all` };
  }
  async list(actor: Actor) {
    const scope = await memberScope(this.db, actor.userId, actor.spaceId);
    const rows = await this.db.teamLeadershipTransfer.findMany({
      where: {
        organizationId: scope.organizationId,
        OR: [{ fromUserId: actor.userId }, { toUserId: actor.userId }],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    await memberScope(this.db, actor.userId, actor.spaceId);
    return rows.map((row) => {
      const s = row.snapshot as Record<string, any>;
      return {
        id: row.id,
        digest: row.digest,
        status: row.status,
        sender: row.fromUserId === actor.userId,
        fromBotId: row.fromBotId,
        toBotId: row.toBotId,
        fromName: s.fromName,
        toName: s.toName,
        sourceRemainsOwner: owner(s.fromRole),
        workflows: s.workflows.map((w: any) => ({ name: w.definition.name, id: w.id })),
        expiresAt: row.expiresAt.toISOString(),
        result: row.result,
      };
    });
  }
  async agent(runId: string, key: string, raw: unknown) {
    const input = leadershipToolInput.parse(raw);
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== "running") throw new Error("Live owned turn required");
    const actor = { userId: run.userId, spaceId: run.spaceId, email: "", isDeploymentOwner: false };
    if (input.operation === "list") return this.list(actor);
    if (!["user", "follow_up"].includes(run.trigger))
      throw new Error("Handover requires a direct manager turn");
    return this.propose(actor, run.botId, input.proposal, runId + ":" + key);
  }
  private async idle(org: string, userId: string) {
    if (
      await this.db.run.count({
        where: {
          userId,
          space: { organizationId: org },
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
      })
    )
      throw new Error("Finish or explicitly stop current agent work before handover");
    const bots = await this.db.bot.findMany({
      where: { userId, space: { organizationId: org } },
      include: { computer: true },
    });
    const live = bots.filter((b) => b.computer?.providerRef);
    if (
      live.some(
        (b) => b.computer?.controlLeaseExpiresAt && b.computer.controlLeaseExpiresAt > new Date(),
      )
    )
      throw new Error("Release computer control first");
    if (live.length) {
      const rows = await this.observe(
        live.map((b) => ({ id: b.computer!.providerRef!, botId: b.id, spaceId: b.spaceId })),
      );
      if (
        rows.length !== live.length ||
        rows.some(
          (r) => r.jobsKnown !== true || !Array.isArray(r.solverJobs) || r.solverJobs.length,
        )
      )
        throw new Error("Numerical work active or unknown; no handover");
    }
  }
  private async note(tx: Tx, s: Record<string, any>, target: boolean, text: string) {
    const threadId = target ? s.toThreadId : s.fromThreadId;
    const botId = target ? s.toBotId : s.fromBotId;
    const spaceId = target ? s.toSpaceId : s.fromSpaceId;
    const blocks = [{ kind: "text" as const, text }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId,
      botId,
      role: "bot",
      blocks,
    });
    await appendEventInTransaction(tx, {
      threadId,
      botId,
      spaceId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
  }
  async decide(
    actor: Actor,
    id: string,
    digest: string,
    operation: "offer" | "accept" | "decline" | "cancel",
  ) {
    const scope = await memberScope(this.db, actor.userId, actor.spaceId);
    const row = await this.db.teamLeadershipTransfer.findFirstOrThrow({
      where: { id, digest, organizationId: scope.organizationId },
    });
    const sender = row.fromUserId === actor.userId;
    const recipient = row.toUserId === actor.userId;
    if (operation === "offer" || operation === "cancel" ? !sender : !recipient)
      throw new Error("Exact handover participant required");
    if (operation === "accept") {
      await this.idle(row.organizationId, row.fromUserId);
      await this.idle(row.organizationId, row.toUserId);
    }
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"team-admin:" + scope.organizationId}, 0))`;
        const current = await tx.teamLeadershipTransfer.findUniqueOrThrow({ where: { id } });
        if (current.digest !== digest || current.expiresAt <= new Date())
          throw new Error("Expired or changed handover");
        if (current.status === "applied" && operation === "accept")
          return { ok: true, status: "applied", replayed: true };
        const s = current.snapshot as Record<string, any>;
        const source = {
          userId: current.fromUserId,
          spaceId: s.fromSpaceId,
          email: "",
          isDeploymentOwner: false,
        };
        if (["offer", "accept"].includes(operation)) {
          const live = await this.snapshot(
            source,
            current.fromBotId,
            current.toBotId,
            s.workflows.map((w: any) => w.id),
            tx,
          );
          if (teamDigest({ snapshot: live, expiresAt: current.expiresAt.toISOString() }) !== digest)
            throw new Error("Manager, successor, bot or flow changed; review again");
        }
        let status: string;
        const newWorkflows: string[] = [];
        if (operation === "offer") {
          if (current.status !== "draft") throw new Error("Only a draft can be offered");
          status = "offered";
          await this.note(
            tx,
            s,
            true,
            `${s.fromName} proposes handing team leadership to your bot. Private histories, files and licenses stay separate. [Review and accept](/app/${s.toBotId}?workflows=all).`,
          );
        } else if (operation === "cancel" || operation === "decline") {
          if (!["draft", "offered"].includes(current.status))
            throw new Error("Handover is already terminal");
          status = operation === "cancel" ? "cancelled" : "declined";
        } else {
          if (current.status !== "offered")
            throw new Error("Sender must confirm the exact offer first");
          // Recheck queued work while holding the same organization lock used by account administration.
          if (
            await tx.run.count({
              where: {
                userId: { in: [current.fromUserId, current.toUserId] },
                space: { organizationId: scope.organizationId },
                status: {
                  in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                },
              },
            })
          )
            throw new Error("Account work changed before handover");
          if (
            await tx.teamAction.count({
              where: { organizationId: scope.organizationId, status: "executing" },
            })
          )
            throw new Error("Account administration is executing");
          if (!owner(s.toRole))
            await tx.member.update({
              where: {
                organizationId_userId: {
                  organizationId: scope.organizationId,
                  userId: current.toUserId,
                },
              },
              data: { role: "admin" },
            });
          if (!owner(s.fromRole))
            await tx.member.update({
              where: {
                organizationId_userId: {
                  organizationId: scope.organizationId,
                  userId: current.fromUserId,
                },
              },
              data: { role: "member" },
            });
          const recipientActor = {
            userId: current.toUserId,
            spaceId: s.toSpaceId,
            email: "",
            isDeploymentOwner: false,
          };
          const service = new TeamWorkflowService(tx as PrismaClient, { enqueue: async () => {} });
          for (const selected of s.workflows) {
            if (
              await tx.teamWorkflowExecution.count({
                where: { workflowId: selected.id, status: "running" },
              })
            )
              throw new Error("Selected workflow still active");
            const definition = { ...selected.definition, leadBotId: current.toBotId };
            const draft = await service.propose(
              recipientActor,
              definition,
              "handover:" + id + ":" + selected.id,
            );
            newWorkflows.push(draft.id);
            await tx.teamWorkflow.update({
              where: { id: selected.id },
              data: { status: "paused" },
            });
          }
          status = "applied";
          const text = `Leadership handed over to ${s.toName}. Private bot histories and files were not transferred. ${newWorkflows.length} workflow definition(s) copied as new drafts needing review and consent. Existing solves and licenses are unchanged; solver access requires separate operator readiness.`;
          await this.note(tx, s, true, text);
          await this.note(tx, s, false, text);
        }
        await tx.teamLeadershipTransfer.update({
          where: { id },
          data: {
            status,
            ...(status === "applied"
              ? {
                  result: { newWorkflows, privateDataTransferred: false, solverTransferred: false },
                }
              : {}),
          },
        });
        await tx.teamAudit.create({
          data: {
            organizationId: scope.organizationId,
            actorUserId: actor.userId,
            operation: "leadership_" + operation,
            targetId: id,
            outcome: status,
          },
        });
        return { ok: true, status };
      },
      { maxWait: 3000, timeout: 15_000 },
    );
  }
}
