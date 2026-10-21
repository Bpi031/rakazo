import { randomUUID } from "node:crypto";
import type { Actor, WorkflowDefinition } from "@rakazo/contracts";
import { workflowDefinitionSchema, workflowToolInput } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type Prisma,
  type PrismaClient,
} from "@rakazo/db";
import { runContinueJob, type JobPublisher } from "@rakazo/adapter-kit";
import { memberScope } from "./team-storage.js";
import { managerRole, teamDigest, teamMessagingEnabled } from "./team-policy.js";
import { workflowText, type WorkflowTextInput, type WorkflowTextResult } from "./workflow-text.js";

type Binding = {
  botId: string;
  userId: string;
  spaceId: string;
  threadId: string;
  name: string;
  role: string;
  version: number;
};
type Step = {
  botId: string;
  userId: string;
  spaceId: string;
  threadId: string;
  runId: string;
  lead: boolean;
  status: "queued" | "started" | "done" | "needs_approval" | "needs_review";
  text?: string;
};
type Flow = Awaited<ReturnType<PrismaClient["teamWorkflow"]["findUniqueOrThrow"]>>;
type Tx = Prisma.TransactionClient;
const json = (value: unknown) => value as Prisma.InputJsonValue;
const bindingsOf = (flow: Flow) => flow.bindings as unknown as Binding[];
const consentsOf = (flow: Flow) => flow.consents as Record<string, boolean>;
const stepsOf = (value: unknown) => value as Step[];
const direct = (trigger: string) => ["user", "follow_up"].includes(trigger);

export class TeamWorkflowService {
  constructor(
    private db: PrismaClient,
    private jobs: Pick<JobPublisher, "enqueue">,
    private generate: (input: WorkflowTextInput) => Promise<WorkflowTextResult> = workflowText,
  ) {}

  private async scope(actor: Actor, manager = false, db: PrismaClient | Tx = this.db) {
    const scope = await memberScope(db as PrismaClient, actor.userId, actor.spaceId);
    if (manager && !managerRole(scope.role)) throw new Error("Team manager required");
    return scope;
  }
  private async bindings(
    actor: Actor,
    definition: WorkflowDefinition,
    db: PrismaClient | Tx = this.db,
  ): Promise<Binding[]> {
    const scope = await this.scope(actor, true, db);
    const output: Binding[] = [];
    for (const botId of [definition.leadBotId, ...definition.participants.map((p) => p.botId)]) {
      const bot = await db.bot.findFirst({
        where: { id: botId, archivedAt: null, space: { organizationId: scope.organizationId } },
        include: { thread: true, computer: true },
      });
      if (!bot?.thread || (bot.computer && bot.computer.scope === "team"))
        throw new Error("Active private bot required");
      const current = await memberScope(db as PrismaClient, bot.userId, bot.spaceId);
      const control = await db.teamMemberControl.findUnique({
        where: {
          organizationId_userId: { organizationId: scope.organizationId, userId: bot.userId },
        },
      });
      if (botId === definition.leadBotId && bot.userId !== actor.userId)
        throw new Error("Lead must be your own bot");
      output.push({
        botId,
        userId: bot.userId,
        spaceId: bot.spaceId,
        threadId: bot.thread.id,
        name: bot.name,
        role: current.role,
        version: control?.version ?? 0,
      });
    }
    return output;
  }
  private async live(flow: Flow, db: PrismaClient | Tx = this.db) {
    const definition = workflowDefinitionSchema.parse(flow.definition);
    if (
      teamDigest({
        organizationId: flow.organizationId,
        managerUserId: flow.managerUserId,
        definition,
        bindings: flow.bindings,
        reviewExpiresAt: flow.reviewExpiresAt.toISOString(),
        expiresAt: flow.expiresAt.toISOString(),
      }) !== flow.digest
    )
      throw new Error("Workflow grant content changed");
    const lead = bindingsOf(flow)[0]!;
    const actor = {
      userId: flow.managerUserId,
      spaceId: lead.spaceId,
      email: "",
      isDeploymentOwner: false,
    };
    if (
      flow.expiresAt <= new Date() ||
      teamDigest(await this.bindings(actor, definition, db)) !== teamDigest(flow.bindings)
    )
      throw new Error("Workflow membership or bot binding changed");
    return definition;
  }
  private ready(flow: Flow) {
    return (
      flow.status === "active" && bindingsOf(flow).every((b) => consentsOf(flow)[b.userId] === true)
    );
  }
  private async audit(tx: Tx, flow: Flow, actorUserId: string, operation: string, outcome: string) {
    await tx.teamAudit.create({
      data: {
        organizationId: flow.organizationId,
        actorUserId,
        operation: "workflow_" + operation,
        targetId: flow.id,
        outcome,
      },
    });
  }
  async propose(actor: Actor, raw: unknown, sourceKey?: string) {
    const definition = workflowDefinitionSchema.parse(raw);
    const scope = await this.scope(actor, true);
    if (!(process.env.CODEX_DEPLOYMENTS ?? "").split(",").includes(definition.modelId))
      throw new Error("Select an approved model route");
    const bindings = await this.bindings(actor, definition);
    if (
      (await this.db.teamWorkflow.count({
        where: { organizationId: scope.organizationId, managerUserId: actor.userId },
      })) >= 100
    )
      throw new Error("Workflow inventory capacity reached");
    const id = sourceKey ? teamDigest({ actor: actor.userId, sourceKey }) : randomUUID();
    const existing = await this.db.teamWorkflow.findUnique({ where: { id } });
    const now = Date.now();
    const reviewExpiresAt = existing?.reviewExpiresAt ?? new Date(now + 86400_000);
    const expiresAt = existing?.expiresAt ?? new Date(now + definition.grantDays * 86400_000);
    const digest = teamDigest({
      organizationId: scope.organizationId,
      managerUserId: actor.userId,
      definition,
      bindings,
      reviewExpiresAt: reviewExpiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    if (existing && existing.digest !== digest)
      throw new Error("Workflow proposal changed during replay");
    const flow =
      existing ??
      (await this.db.teamWorkflow.create({
        data: {
          id,
          organizationId: scope.organizationId,
          managerUserId: actor.userId,
          leadBotId: definition.leadBotId,
          definition: json(definition),
          bindings: json(bindings),
          digest,
          reviewExpiresAt,
          expiresAt,
        },
      }));
    return {
      id: flow.id,
      digest,
      status: "draft",
      reviewUrl: `/app/${definition.leadBotId}?workflows=${flow.id}`,
    };
  }
  async list(actor: Actor, only?: string) {
    const scope = await this.scope(actor);
    const flows = await this.db.teamWorkflow.findMany({
      where: { organizationId: scope.organizationId, ...(only ? { id: only } : {}) },
      orderBy: { createdAt: "desc" },
      take: 101,
    });
    if (flows.length > 100) throw new Error("Workflow inventory pagination required");
    const visible = flows.filter(
      (f) =>
        f.managerUserId === actor.userId || bindingsOf(f).some((b) => b.userId === actor.userId),
    );
    const result = await Promise.all(
      visible.map(async (flow) => {
        const definition = workflowDefinitionSchema.parse(flow.definition);
        const manager = flow.managerUserId === actor.userId && managerRole(scope.role);
        const executions = await this.db.teamWorkflowExecution.findMany({
          where: { workflowId: flow.id },
          orderBy: { createdAt: "desc" },
          take: 10,
        });
        let live = true;
        try {
          await this.live(flow);
        } catch {
          live = false;
        }
        return {
          id: flow.id,
          digest: flow.digest,
          name: definition.name,
          status: live ? flow.status : "needs_review",
          ready: live && this.ready(flow),
          manager,
          leadBotId: flow.leadBotId,
          definition,
          expiresAt: flow.expiresAt.toISOString(),
          reviewExpiresAt: flow.reviewExpiresAt.toISOString(),
          participants: bindingsOf(flow).map((b) => ({
            botId: b.botId,
            name: b.name,
            consented: consentsOf(flow)[b.userId] === true,
            you: b.userId === actor.userId,
          })),
          executions: executions.map((e) => ({
            id: e.id,
            status: e.status,
            createdAt: e.createdAt.toISOString(),
            steps: stepsOf(e.tasks)
              .filter((t) => manager || t.userId === actor.userId)
              .map((t) => ({ botId: t.botId, lead: t.lead, status: t.status, text: t.text })),
          })),
        };
      }),
    );
    if ((await this.scope(actor)).role !== scope.role)
      throw new Error("Workflow reader role changed");
    return result;
  }
  async decide(
    actor: Actor,
    id: string,
    digest: string,
    operation: "enable" | "pause" | "consent" | "revoke",
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"workflow:" + id}, 0))`;
      const scope = await this.scope(actor, false, tx);
      const flow = await tx.teamWorkflow.findFirstOrThrow({
        where: { id, organizationId: scope.organizationId, digest },
      });
      const own = bindingsOf(flow).some((b) => b.userId === actor.userId);
      if (
        ["enable", "pause"].includes(operation) &&
        (flow.managerUserId !== actor.userId || !managerRole(scope.role))
      )
        throw new Error("Workflow owner manager required");
      if (["consent", "revoke"].includes(operation) && !own)
        throw new Error("Recipient owner required");
      if (!["pause", "revoke"].includes(operation)) await this.live(flow, tx);
      if (operation === "enable" && flow.status === "draft" && flow.reviewExpiresAt <= new Date())
        throw new Error("Workflow review expired");
      const consents = {
        ...consentsOf(flow),
        ...(operation === "enable" || operation === "consent"
          ? { [actor.userId]: true }
          : operation === "revoke"
            ? { [actor.userId]: false }
            : {}),
      };
      const status =
        operation === "enable" ? "active" : operation === "pause" ? "paused" : flow.status;
      await tx.teamWorkflow.update({ where: { id }, data: { consents, status } });
      if (operation === "enable" && flow.status === "draft") {
        for (const recipient of bindingsOf(flow).filter((b) => b.userId !== actor.userId)) {
          await this.note(
            tx,
            recipient,
            `A manager proposed a message-only team flow: ${workflowDefinitionSchema.parse(flow.definition).name}. Nothing is enabled for your bot until you consent. [Review exact flow](/app/${recipient.botId}?workflows=${flow.id}).`,
          );
        }
      }
      if (operation === "pause" || operation === "revoke") {
        const executions = await tx.teamWorkflowExecution.findMany({
          where: { workflowId: id, status: "running" },
        });
        await tx.teamWorkflowExecution.updateMany({
          where: { workflowId: id, status: "running" },
          data: { status: "needs_review" },
        });
        await tx.run.updateMany({
          where: {
            id: { in: executions.flatMap((e) => e.runIds) },
            trigger: "team_workflow",
            status: "queued",
          },
          data: { status: "cancelled", completedAt: new Date() },
        });
      }
      await this.audit(tx, flow, actor.userId, operation, "applied");
      return { ok: true, status };
    });
  }
  async agent(runId: string, key: string, raw: unknown) {
    const args = workflowToolInput.parse(raw);
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== "running") throw new Error("Live owned turn required");
    const actor = { userId: run.userId, spaceId: run.spaceId, email: "", isDeploymentOwner: false };
    await this.scope(actor);
    if (args.operation === "list" || args.operation === "inspect")
      return this.list(actor, args.workflowId);
    if (!direct(run.trigger))
      throw new Error("Workflow configuration and submission require a direct human turn");
    if (args.operation === "propose")
      return this.propose(actor, args.definition, runId + ":" + key);
    if (args.operation === "directory") {
      const scope = await this.scope(actor);
      return this.db.bot.findMany({
        where: { archivedAt: null, space: { organizationId: scope.organizationId } },
        select: { id: true, name: true, userId: true },
        take: 100,
      });
    }
    if (!args.workflowId || !args.message)
      throw new Error("Exact workflow and shared message required");
    return this.start(
      actor,
      run.botId,
      args.workflowId,
      args.message,
      runId + ":" + key,
      args.operation === "submit",
    );
  }
  private async queue(
    tx: Tx,
    executionId: string,
    binding: Binding,
    lead: boolean,
    text: string,
  ): Promise<Step> {
    const message = await this.note(
      tx,
      binding,
      `Team workflow ${executionId}. Shared message only; no policy approval or file access.\n\n${text}`,
      "user",
    );
    const task = await tx.task.create({
      data: {
        userId: binding.userId,
        spaceId: binding.spaceId,
        botId: binding.botId,
        threadId: binding.threadId,
        prompt: "Message-only workflow step",
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        userId: binding.userId,
        spaceId: binding.spaceId,
        botId: binding.botId,
        threadId: binding.threadId,
        taskId: task.id,
        sourceMessageId: message.id,
        trigger: "team_workflow",
        status: "queued",
      },
    });
    return { ...binding, runId: run.id, lead, status: "queued" };
  }
  private async note(
    tx: Tx,
    binding: Pick<Binding, "threadId" | "spaceId" | "botId">,
    text: string,
    role: "user" | "bot" = "bot",
    runId?: string,
  ) {
    const blocks = [{ kind: "text" as const, text }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: binding.threadId,
      role,
      botId: role === "bot" ? binding.botId : undefined,
      blocks,
      runId,
    });
    await appendEventInTransaction(tx, {
      threadId: binding.threadId,
      spaceId: binding.spaceId,
      botId: binding.botId,
      runId,
      type: "thread.message.created",
      payload: { messageId: message.id, role, blocks },
    });
    return message;
  }
  private async publish(runIds: string[]) {
    for (const id of runIds)
      try {
        await this.jobs.enqueue(runContinueJob(id));
      } catch {
        /* Durable queued runs are recovered by the existing run sweeper. */
      }
  }
  async start(
    actor: Actor,
    botId: string,
    id: string,
    message: string,
    sourceKey: string,
    participant = false,
  ) {
    workflowToolInput.parse({ operation: "start", workflowId: id, message });
    if (!message.trim() || message.length > 8000 || sourceKey.length > 400)
      throw new Error("Bounded shared input required");
    const result = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"workflow:" + id}, 0))`;
      const scope = await this.scope(actor, false, tx);
      const flow = await tx.teamWorkflow.findFirstOrThrow({
        where: { id, organizationId: scope.organizationId },
      });
      const definition = await this.live(flow, tx);
      const bindings = bindingsOf(flow);
      const sender = bindings.find(
        (b) => b.botId === botId && b.userId === actor.userId && b.spaceId === actor.spaceId,
      );
      if (
        !sender ||
        !this.ready(flow) ||
        (participant
          ? !definition.allowParticipantStart || botId === flow.leadBotId
          : botId !== flow.leadBotId || actor.userId !== flow.managerUserId)
      )
        throw new Error("Workflow start not authorized");
      const existing = await tx.teamWorkflowExecution.findUnique({
        where: { workflowId_sourceKey: { workflowId: id, sourceKey } },
      });
      if (existing) {
        if (existing.message !== message || existing.sourceUserId !== actor.userId)
          throw new Error("Submission changed");
        return existing;
      }
      // Expired work is terminal review evidence, never silently retried.
      await tx.teamWorkflowExecution.updateMany({
        where: { workflowId: id, status: "running", expiresAt: { lte: new Date() } },
        data: { status: "needs_review" },
      });
      if (await tx.teamWorkflowExecution.count({ where: { workflowId: id, status: "running" } }))
        throw new Error("One active execution per workflow");
      if (
        (await tx.teamWorkflowExecution.count({
          where: { workflowId: id, createdAt: { gte: new Date(Date.now() - 86400_000) } },
        })) >= definition.maxStartsPerDay
      )
        throw new Error("Workflow daily allowance exhausted");
      const executionId = randomUUID();
      const tasks = [];
      for (const binding of bindings.slice(1))
        tasks.push(await this.queue(tx, executionId, binding, false, message));
      const execution = await tx.teamWorkflowExecution.create({
        data: {
          id: executionId,
          workflowId: id,
          organizationId: scope.organizationId,
          sourceUserId: actor.userId,
          sourceKey,
          message,
          tasks: json(tasks),
          runIds: tasks.map((t) => t.runId),
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });
      await this.audit(tx, flow, actor.userId, "start", "queued");
      return execution;
    });
    await this.publish(result.runIds);
    return { id: result.id, status: result.status, reviewUrl: `/app/${botId}?workflows=${id}` };
  }

  async continueRun(runId: string) {
    let execution = await this.db.teamWorkflowExecution.findFirst({
      where: { runIds: { has: runId } },
    });
    if (!execution) throw new Error("Workflow run has no owned execution");
    let input: WorkflowTextInput | undefined;
    try {
      if (!teamMessagingEnabled()) throw new Error("Team workflows disabled by operator");
      input = await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"workflow:" + execution!.workflowId}, 0))`;
        const e = await tx.teamWorkflowExecution.findUniqueOrThrow({
          where: { id: execution!.id },
        });
        const flow = await tx.teamWorkflow.findUniqueOrThrow({ where: { id: e.workflowId } });
        const definition = await this.live(flow, tx);
        const steps = stepsOf(e.tasks);
        const step = steps.find((s) => s.runId === runId);
        if (
          !step ||
          step.status === "done" ||
          step.status === "needs_approval" ||
          step.status === "needs_review"
        )
          return undefined;
        if (step.status === "started") {
          const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
          if (!run.startedAt || Date.now() - run.startedAt.getTime() > 120_000)
            throw new Error("Ambiguous previously started step requires review");
          return undefined;
        }
        if (e.status !== "running" || e.expiresAt <= new Date() || !this.ready(flow))
          throw new Error("Workflow no longer runnable");
        const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
        if (
          run.trigger !== "team_workflow" ||
          run.userId !== step.userId ||
          run.botId !== step.botId ||
          run.spaceId !== step.spaceId ||
          run.threadId !== step.threadId ||
          run.status !== "queued"
        )
          throw new Error("Workflow run scope changed");
        step.status = "started";
        await tx.teamWorkflowExecution.update({
          where: { id: e.id },
          data: { tasks: json(steps) },
        });
        await tx.run.update({
          where: { id: runId },
          data: {
            status: "running",
            startedAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + 120_000),
          },
        });
        const instruction = step.lead
          ? definition.objective
          : definition.participants.find((p) => p.botId === step.botId)!.instruction;
        const message = step.lead
          ? JSON.stringify({
              sharedInput: e.message,
              responses: steps
                .filter((s) => !s.lead)
                .map((s) => ({ botId: s.botId, text: s.text })),
            })
          : e.message;
        return {
          userId: step.userId,
          spaceId: step.spaceId,
          botId: step.botId,
          runId,
          modelId: definition.modelId,
          instruction,
          message,
          maxOutputTokens: definition.maxOutputTokens,
        };
      });
      if (!input) return;
      const result = await this.generate(input);
      const count = (x: unknown) =>
        Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) <= 2147483647 ? Number(x) : null;
      const cached = count((result.usage?.input_tokens_details as any)?.cached_tokens);
      const totalInput = count(result.usage?.input_tokens);
      const usage = {
        userId: input.userId,
        spaceId: input.spaceId,
        botId: input.botId,
        runId,
        provider: "codex-foundry",
        model: input.modelId,
        callId: "workflow:" + runId,
        operationKind: "team_workflow",
        inputTokens:
          totalInput !== null && cached !== null && cached <= totalInput
            ? totalInput - cached
            : null,
        cacheReadTokens: cached,
        outputTokens: count(result.usage?.output_tokens),
        totalTokens: count(result.usage?.total_tokens),
        usageSource: "workflow-protected-route",
      };
      // Account for actual calls even if consent was revoked while inference ran.
      await this.db.usageRecord.upsert({
        where: { callId: usage.callId },
        create: usage,
        update: {},
      });
      const queued = await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"workflow:" + execution!.workflowId}, 0))`;
        const e = await tx.teamWorkflowExecution.findUniqueOrThrow({
          where: { id: execution!.id },
        });
        const flow = await tx.teamWorkflow.findUniqueOrThrow({ where: { id: e.workflowId } });
        await this.live(flow, tx);
        if (e.status !== "running" || e.expiresAt <= new Date() || !this.ready(flow))
          throw new Error("Workflow authorization revoked before delivery");
        const steps = stepsOf(e.tasks);
        const step = steps.find((s) => s.runId === runId)!;
        if (step.status !== "started") throw new Error("Workflow delivery already settled");
        const currentRun = await tx.run.findUniqueOrThrow({ where: { id: runId } });
        if (currentRun.status !== "running" || currentRun.trigger !== "team_workflow" ||
            currentRun.botId !== step.botId || currentRun.userId !== step.userId ||
            currentRun.spaceId !== step.spaceId || currentRun.threadId !== step.threadId)
          throw new Error("Workflow run cancelled or changed before delivery");
        if (
          !result.text.trim() ||
          result.text.length > 8000 ||
          typeof result.needsApproval !== "boolean"
        )
          throw new Error("Bounded workflow result required");
        step.text = result.text;
        step.status = result.needsApproval ? "needs_approval" : "done";
        await this.note(
          tx,
          step,
          `Workflow ${result.needsApproval ? "awaiting human decision" : "analysis"}; no files or policy changed.\n\n${result.text}`,
          "bot",
          runId,
        );
        await appendEventInTransaction(tx, {
          threadId: step.threadId,
          spaceId: step.spaceId,
          botId: step.botId,
          runId,
          type: "run.completed",
          payload: { runId },
        });
        await tx.run.update({
          where: { id: runId },
          data: { status: "completed", completedAt: new Date() },
        });
        const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
        await tx.task.update({ where: { id: run.taskId }, data: { status: "completed" } });
        const next: string[] = [];
        let status = result.needsApproval ? "needs_approval" : step.lead ? "completed" : "running";
        if (!result.needsApproval && !step.lead && steps.every((s) => s.status === "done")) {
          const lead = await this.queue(
            tx,
            e.id,
            bindingsOf(flow)[0]!,
            true,
            "Consolidate the explicitly shared workflow responses.",
          );
          steps.push(lead);
          next.push(lead.runId);
        }
        await tx.teamWorkflowExecution.update({
          where: { id: e.id },
          data: { tasks: json(steps), runIds: steps.map((s) => s.runId), status },
        });
        await this.audit(tx, flow, step.userId, "step", status);
        return next;
      });
      await this.publish(queued);
    } catch {
      // A started inference is never automatically repeated after a crash or ambiguous failure.
      await this.db.$transaction(async (tx) => {
        await tx.teamWorkflowExecution.updateMany({
          where: { id: execution.id, status: "running" },
          data: { status: "needs_review" },
        });
        const run = await tx.run.findUnique({ where: { id: runId } });
        if (
          run?.trigger === "team_workflow" &&
          ["queued", "running", "leased"].includes(run.status)
        ) {
          await this.note(
            tx,
            { threadId: run.threadId, botId: run.botId, spaceId: run.spaceId },
            "Team workflow paused for review. No automatic retry, policy change or solver action was performed.",
          );
          await appendEventInTransaction(tx, {
            threadId: run.threadId,
            botId: run.botId,
            spaceId: run.spaceId,
            type: "run.failed",
            payload: { runId, error: "Workflow requires review" },
          });
          await tx.run.update({
            where: { id: runId },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: "Workflow paused for review; no automatic retry or action",
            },
          });
          await tx.task.update({ where: { id: run.taskId }, data: { status: "failed" } });
        }
      });
    }
  }
}
