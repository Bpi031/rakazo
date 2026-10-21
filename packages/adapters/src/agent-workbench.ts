import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  GoalInput,
  HelperInput,
  WorkbenchToolInput,
  safeText,
  type Actor,
} from "@rakazo/contracts";
import { createRepos, type PrismaClient, type Prisma } from "@rakazo/db";
import type { SandboxProvider, AdapterContext } from "@rakazo/adapter-kit";
import { memberScope } from "./team-storage.js";
import { teamDigest } from "./team-policy.js";
import { toComputerRef } from "./computer-support.js";
import { workflowText } from "./workflow-text.js";
import { z } from "zod";

const files = readFileSync(new URL("./workbench-files.py", import.meta.url), "utf8");
const filesDigest = createHash("sha256").update(files).digest("hex");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const now = () => new Date();
const stableId = (key: string) => {
  const h = teamDigest(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const workbenchEnabled = () => process.env.ROST_CODEX_WORKBENCH === "1";
export const protectedHooks = Object.freeze([
  {
    name: "private-owner",
    phase: "before_tool",
    version: 1,
    description: "Current owned private bot and active membership required",
  },
  {
    name: "bounded-analysis",
    phase: "before_helper",
    version: 1,
    description:
      "Explicit text only; same approved model; finite reservations; no tools or automatic retry",
  },
  {
    name: "source-bound-draft",
    phase: "before_draft",
    version: 1,
    description: "Fresh digest; separate new file; no overwrite, policy approval or solve",
  },
  {
    name: "finish-boundary",
    phase: "before_finish",
    version: 1,
    description:
      "Live owned turn required; completion never grants policy approval or solver allowance",
  },
]);
export class AgentWorkbench {
  constructor(
    private deps: {
      prisma: PrismaClient;
      sandbox?: SandboxProvider;
      generate?: typeof workflowText;
      helperAuthority?: "native_read_only_worker";
    },
  ) {}
  private get db() {
    return this.deps.prisma;
  }
  private async owned(actor: Actor, botId: string, db = this.db) {
    await memberScope(db, actor.userId, actor.spaceId);
    const bot = await db.bot.findFirstOrThrow({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      include: { computer: true, thread: true },
    });
    if (bot.computer?.scope === "team") throw new Error("A private bot is required");
    return bot;
  }
  private where(actor: Actor, botId: string) {
    return { spaceId: actor.spaceId, userId: actor.userId, botId };
  }
  private async row(actor: Actor, botId: string, id: string, kind?: string, db = this.db) {
    await this.owned(actor, botId, db);
    return db.agentWorkbenchRecord.findFirstOrThrow({
      where: { ...this.where(actor, botId), id, ...(kind ? { kind } : {}) },
    });
  }
  private async create(
    actor: Actor,
    botId: string,
    kind: string,
    payload: unknown,
    options: { id?: string; runId?: string; status?: string; expiresAt?: Date } = {},
    db = this.db,
  ) {
    if (Buffer.byteLength(JSON.stringify(payload)) > 200000)
      throw new Error("Workbench record cap");
    const data = {
      ...this.where(actor, botId),
      id: options.id ?? randomUUID(),
      kind,
      status: options.status ?? "draft",
      digest: teamDigest(payload),
      payload: json(payload),
      runId: options.runId,
      expiresAt: options.expiresAt,
    };
    return db.agentWorkbenchRecord.create({ data });
  }
  async hook(runId: string, hook: string, outcome = "passed") {
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== "running" || !protectedHooks.some((h) => h.name === hook))
      throw new Error("Live owned hook required");
    const actor = { userId: run.userId, spaceId: run.spaceId, email: "", isDeploymentOwner: false };
    await this.owned(actor, run.botId);
    // One immutable receipt per owned run/hook, not raw prompt, output or arbitrary shell code.
    const id = teamDigest({ runId, hook });
    const payload = {
      hook,
      outcome,
      manifest: teamDigest(protectedHooks),
      policyApprovalGranted: false,
      solveStarted: false,
    };
    await this.db.agentWorkbenchRecord.upsert({
      where: { id },
      create: {
        ...this.where(actor, run.botId),
        id,
        kind: "hook",
        runId,
        status: outcome,
        digest: teamDigest(payload),
        payload: json(payload),
      },
      update: {},
    });
  }
  async view(actor: Actor, botId: string) {
    await this.owned(actor, botId);
    const rows = await this.db.agentWorkbenchRecord.findMany({
      where: this.where(actor, botId),
      orderBy: { createdAt: "desc" },
      take: 150,
    });
    await this.owned(actor, botId);
    const metadata = await this.db.agentWorkbenchRecord.findMany({
      where: { ...this.where(actor, botId), kind: { in: ["goal", "skills", "skill_selection"] } },
    });
    const selected = metadata.find((r) => r.kind === "skill_selection");
    const goal = metadata.find((r) => r.kind === "goal");
    return {
      botId,
      goal: goal?.payload ?? { objective: "", status: "paused", revision: 0 },
      selectedSkill: selected?.payload ?? null,
      hooks: protectedHooks,
      manifestDigest: teamDigest(protectedHooks),
      records: rows
        .filter((r) => !["skill_selection", "goal", "skills"].includes(r.kind))
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          digest: r.digest,
          createdAt: r.createdAt.toISOString(),
          title: String(
            (r.payload as any).title ??
              (r.payload as any).name ??
              (r.payload as any).path ??
              (r.payload as any).objective ??
              (r.payload as any).hook ??
              r.kind,
          ).slice(0, 200),
        })),
      skills: (metadata.find((r) => r.kind === "skills")?.payload as any)?.skills ?? [],
      policyApprovalGranted: false,
      solveStarted: false,
    };
  }
  async detail(actor: Actor, botId: string, id: string) {
    const row = await this.row(actor, botId, id);
    return {
      id,
      kind: row.kind,
      status: row.status,
      digest: row.digest,
      payload: row.payload,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
  }
  async goal(actor: Actor, botId: string, revision: number, raw: unknown) {
    const goal = GoalInput.parse(raw);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"workbench:" + botId}, 0))`;
      await this.owned(actor, botId, tx as PrismaClient);
      const id = teamDigest({ ...this.where(actor, botId), kind: "goal" });
      const old = await tx.agentWorkbenchRecord.findUnique({ where: { id } });
      if (((old?.payload as any)?.revision ?? 0) !== revision)
        throw new Error("Goal changed; refresh first");
      const payload = {
        ...goal,
        revision: revision + 1,
        changedBy: actor.userId,
        authority: "user_task_tracking",
        policyApprovalGranted: false,
        solveStarted: false,
      };
      return tx.agentWorkbenchRecord.upsert({
        where: { id },
        create: {
          id,
          ...this.where(actor, botId),
          kind: "goal",
          status: goal.status,
          digest: teamDigest(payload),
          payload: json(payload),
        },
        update: { status: goal.status, digest: teamDigest(payload), payload: json(payload) },
      });
    });
  }
  private async executeFiles(actor: Actor, botId: string, input: Record<string, unknown>) {
    const bot = await this.owned(actor, botId);
    if (!this.deps.sandbox || !bot.computer?.providerRef || bot.computer.state !== "running")
      throw new Error("Start the existing private computer first");
    const context: AdapterContext = {
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId,
      operationId: "workbench:" + randomUUID(),
      traceId: "workbench-files",
      signal: AbortSignal.timeout(20_000),
    };
    const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
    if (encoded.length > 270000) throw new Error("Workbench transport cap");
    let stdout = "",
      code: number | undefined;
    for await (const event of this.deps.sandbox.execute(
      toComputerRef(bot.computer),
      {
        argv: ["/opt/office-python/bin/python3", "-I", "-c", files, encoded],
        cwd: "/home/rakazo",
        timeoutMs: 15000,
        unsetEnv: ["PYTHONPATH", "PYTHONHOME", "LD_PRELOAD"],
      },
      context,
    )) {
      if (event.type === "stdout") {
        stdout += event.data;
        if (Buffer.byteLength(stdout) > 200000) throw new Error("Workbench output cap");
      }
      if (event.type === "exit") code = event.code;
    }
    const result = JSON.parse(stdout);
    if (code !== 0 || result.error)
      throw new Error("File source changed, unavailable or outside the finite private boundary");
    await this.owned(actor, botId);
    return result;
  }
  async skills(actor: Actor, botId: string) {
    const result = await this.executeFiles(actor, botId, { operation: "skills" });
    if (!Array.isArray(result.skills) || result.skills.length > 64)
      throw new Error("Invalid installed skills");
    const id = teamDigest({ ...this.where(actor, botId), kind: "skills" });
    await this.db.agentWorkbenchRecord.upsert({
      where: { id },
      create: {
        id,
        ...this.where(actor, botId),
        kind: "skills",
        status: "observed",
        digest: teamDigest(result),
        payload: json(result),
      },
      update: { payload: json(result), digest: teamDigest(result) },
    });
    return result.skills;
  }
  async selectSkill(actor: Actor, botId: string, id: string | null) {
    await this.owned(actor, botId);
    const skills = id ? await this.skills(actor, botId) : [];
    const selected = id ? skills.find((s: any) => s.id === id) : null;
    if (id && !selected) throw new Error("Installed skill changed; refresh first");
    const key = teamDigest({ ...this.where(actor, botId), kind: "skill_selection" });
    const payload = selected ? { ...selected, nextTurnOnly: true } : { selected: null };
    await this.db.agentWorkbenchRecord.upsert({
      where: { id: key },
      create: {
        id: key,
        ...this.where(actor, botId),
        kind: "skill_selection",
        status: "selected",
        digest: teamDigest(payload),
        payload: json(payload),
      },
      update: { payload: json(payload), digest: teamDigest(payload) },
    });
    return { selectedSkill: selected };
  }
  async turnContext(runId: string) {
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } });
    const actor = { userId: run.userId, spaceId: run.spaceId, email: "", isDeploymentOwner: false };
    const view = await this.view(actor, run.botId);
    const selected = view.selectedSkill as any;
    let skill: { name: string; path: string } | undefined;
    if (selected?.id) {
      const live = (await this.skills(actor, run.botId)).find((s: any) => s.id === selected.id);
      if (!live) throw new Error("Selected skill changed; choose again");
      const id = teamDigest({ ...this.where(actor, run.botId), kind: "skill_selection" });
      const consumed = await this.db.agentWorkbenchRecord.updateMany({
        where: { id, digest: teamDigest(selected) },
        data: {
          status: "consumed",
          payload: { selected: null },
          digest: teamDigest({ selected: null }),
        },
      });
      if (consumed.count === 1) skill = { name: live.name, path: live.path };
    }
    return { selectedSkill: skill, goal: view.goal };
  }
  async proposeChange(
    actor: Actor,
    botId: string,
    path: string,
    proposedText: string,
    runId?: string,
    effectKey?: string,
  ) {
    await this.owned(actor, botId);
    safeText(64000).parse(proposedText);
    if (Buffer.byteLength(proposedText) > 64000) throw new Error("Draft byte cap");
    const id = effectKey
      ? stableId(teamDigest({ ...this.where(actor, botId), effectKey }))
      : randomUUID();
    const old = await this.db.agentWorkbenchRecord.findFirst({
      where: { ...this.where(actor, botId), id, kind: "change" },
    });
    if (old) {
      const payload = old.payload as any;
      if (payload.path !== path || payload.proposedText !== proposedText)
        throw new Error("Draft replay changed");
      return {
        id: old.id,
        digest: old.digest,
        reviewUrl: `/app/${botId}?workbench=changes&review=${old.id}`,
        replayed: true,
        policyApprovalGranted: false,
        solveStarted: false,
      };
    }
    if (
      (await this.db.agentWorkbenchRecord.count({
        where: {
          ...this.where(actor, botId),
          kind: "change",
          createdAt: { gt: new Date(Date.now() - 86400_000) },
        },
      })) >= 20
    )
      throw new Error("Daily draft cap");
    const source = await this.executeFiles(actor, botId, { operation: "capture", path });
    if (runId) await this.hook(runId, "source-bound-draft");
    const row = await this.create(
      actor,
      botId,
      "change",
      {
        ...source,
        proposedText,
        helperSha256: filesDigest,
        policyApprovalGranted: false,
        solveStarted: false,
      },
      { id, runId, expiresAt: new Date(Date.now() + 86400_000) },
    );
    return {
      id: row.id,
      digest: row.digest,
      reviewUrl: `/app/${botId}?workbench=changes&review=${row.id}`,
      policyApprovalGranted: false,
      solveStarted: false,
    };
  }
  async saveDraft(actor: Actor, botId: string, id: string, digest: string) {
    const row = await this.row(actor, botId, id, "change");
    if (
      row.digest !== digest ||
      !row.expiresAt ||
      row.expiresAt <= now() ||
      !["draft", "saved"].includes(row.status)
    )
      throw new Error("Draft review changed or expired");
    const payload = row.payload as any;
    if (teamDigest(payload) !== digest || payload.helperSha256 !== filesDigest)
      throw new Error("Review implementation changed");
    const saved = await this.executeFiles(actor, botId, {
      operation: "save",
      id,
      path: payload.path,
      proposedText: payload.proposedText,
      sourceSha256: payload.sourceSha256,
    });
    await this.db.agentWorkbenchRecord.update({ where: { id }, data: { status: "saved" } });
    const receiptId = teamDigest({ draftReview: id, kind: "receipt" });
    await this.db.agentWorkbenchRecord.upsert({
      where: { id: receiptId },
      create: {
        id: receiptId,
        ...this.where(actor, botId),
        kind: "draft_receipt",
        status: "saved",
        digest: teamDigest(saved),
        payload: json({ ...saved, reviewId: id, title: saved.draftPath }),
      },
      update: {},
    });
    return saved;
  }
  async scenario(actor: Actor, botId: string, title: string, effectKey?: string) {
    const bot = await this.owned(actor, botId);
    const id = effectKey
      ? stableId(teamDigest({ ...this.where(actor, botId), effectKey }))
      : randomUUID();
    const old = await this.db.agentWorkbenchRecord.findFirst({
      where: { ...this.where(actor, botId), id, kind: "scenario" },
    });
    if (old) {
      if ((old.payload as any).title !== title) throw new Error("Scenario replay changed");
      return old;
    }
    if (
      (await this.db.agentWorkbenchRecord.count({
        where: { ...this.where(actor, botId), kind: "scenario" },
      })) >= 20
    )
      throw new Error("Scenario inventory cap");
    const source = bot.thread
      ? await this.db.message.findMany({
          where: { threadId: bot.thread.id, role: { in: ["user", "bot"] } },
          orderBy: { createdAt: "desc" },
          take: 12,
        })
      : [];
    const context = source.reverse().map((m) => ({
      role: m.role,
      messageId: m.id,
      text: (m.blocks as any[])
        .filter((b) => b.kind === "text")
        .map((b) => b.text)
        .join("\n")
        .slice(0, 4000),
    }));
    return this.create(
      actor,
      botId,
      "scenario",
      {
        title,
        context,
        sourceDigest: teamDigest(context),
        messages: [],
        authority: "analysis_only",
        filesCopied: false,
        policyApprovalGranted: false,
        solveStarted: false,
      },
      { id },
    );
  }
  private async account(
    actor: Actor,
    botId: string,
    id: string,
    runId: string | undefined,
    model: string,
    usage?: Record<string, unknown>,
  ) {
    const count = (x: unknown) =>
      Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) <= 2147483647 ? Number(x) : null;
    const input = count(usage?.input_tokens),
      cached = count((usage?.input_tokens_details as any)?.cached_tokens);
    const data = {
      ...this.where(actor, botId),
      runId,
      provider: "codex-foundry",
      model,
      callId: "workbench:" + id,
      operationKind: "subagent",
      agentId: id,
      parentRunId: runId,
      inputTokens: input !== null && cached !== null && cached <= input ? input - cached : null,
      cacheReadTokens: cached,
      outputTokens: count(usage?.output_tokens),
      totalTokens: count(usage?.total_tokens),
      usageSource: "workbench-protected-route",
    };
    await this.db.usageRecord.upsert({ where: { callId: data.callId }, create: data, update: {} });
  }
  private async infer(
    actor: Actor,
    botId: string,
    id: string,
    kind: "helper" | "scenario_call",
    name: string,
    message: string,
    instruction: string,
    runId?: string,
  ) {
    const bot = await this.owned(actor, botId);
    const run = runId ? await this.db.run.findUniqueOrThrow({ where: { id: runId } }) : null;
    if (
      run &&
      (run.userId !== actor.userId ||
        run.botId !== botId ||
        run.spaceId !== actor.spaceId ||
        run.status !== "running")
    )
      throw new Error("Owned live turn required");
    const model =
      run?.modelId ??
      bot.modelId ??
      process.env.CODEX_DEFAULT_MODEL ??
      (process.env.CODEX_DEPLOYMENTS ?? "").split(",")[0];
    if (!model || !(process.env.CODEX_DEPLOYMENTS ?? "").split(",").includes(model))
      throw new Error("Approved model required");
    const scope = await memberScope(this.db, actor.userId, actor.spaceId);
    const scopeDigest = teamDigest({ role: scope.role, control: scope.control?.version ?? 0 });
    const inputDigest = teamDigest({ name, message, instruction, model });
    const reservation = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"workbench:" + botId}, 0))`;
      const old = await tx.agentWorkbenchRecord.findUnique({ where: { id } });
      if (old) {
        if (
          old.userId !== actor.userId ||
          old.spaceId !== actor.spaceId ||
          old.botId !== botId ||
          (old.payload as any).inputDigest !== inputDigest ||
          (old.payload as any).scopeDigest !== scopeDigest
        )
          throw new Error("Analysis replay changed");
        if (old.status === "completed") return old;
        throw new Error("Analysis already started or needs review; no automatic retry");
      }
      const where = { ...this.where(actor, botId), kind: { in: ["helper", "scenario_call"] } };
      if (
        (await tx.agentWorkbenchRecord.count({
          where: { ...where, status: "started", createdAt: { gt: new Date(Date.now() - 120_000) } },
        })) >= 2 ||
        (await tx.agentWorkbenchRecord.count({
          where: { ...where, createdAt: { gt: new Date(Date.now() - 86400_000) } },
        })) >= 20 ||
        (runId && (await tx.agentWorkbenchRecord.count({ where: { runId, kind: "helper" } })) >= 3)
      )
        throw new Error("Finite analysis allowance exhausted");
      return this.create(
        actor,
        botId,
        kind,
        { name, inputDigest, model, scopeDigest },
        { id, runId, status: "started" },
        tx as PrismaClient,
      );
    });
    if (reservation.status === "completed") return (reservation.payload as any).result;
    try {
      const result = await (this.deps.generate ?? workflowText)({
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId,
        runId: runId ?? id,
        modelId: model,
        instruction,
        message,
        maxOutputTokens: 1024,
      });
      await this.account(actor, botId, id, runId, model, result.usage);
      await this.owned(actor, botId);
      const fresh = await memberScope(this.db, actor.userId, actor.spaceId);
      if (
        teamDigest({ role: fresh.role, control: fresh.control?.version ?? 0 }) !== scopeDigest ||
        (runId &&
          (await this.db.run.findUniqueOrThrow({ where: { id: runId } })).status !== "running")
      )
        throw new Error("Analysis authority changed before delivery");
      safeText(8000).pipe(z.string().min(1)).parse(result.text);
      z.boolean().parse(result.needsApproval);
      const value = {
        name,
        text: result.text,
        needsApproval: result.needsApproval,
        authority: this.deps.helperAuthority ?? "message_only_analysis",
        solveStarted: false,
        policyApprovalGranted: false,
      };
      await this.db.agentWorkbenchRecord.update({
        where: { id },
        data: {
          status: "completed",
          payload: json({ ...(reservation.payload as any), result: value }),
        },
      });
      return value;
    } catch (error) {
      await this.db.agentWorkbenchRecord.updateMany({
        where: { id, status: "started" },
        data: { status: "needs_review" },
      });
      throw new Error(
        "Analysis failed or requires review; no automatic retry, policy change or solver action",
      );
    }
  }
  async helper(runId: string, executionId: string, raw: unknown) {
    const args = HelperInput.parse(raw);
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } });
    if (
      (args.model_provider && args.model_provider !== "codex-foundry") ||
      (args.model_id && args.model_id !== run.modelId)
    )
      throw new Error("Helpers use the parent's approved model; no fallback");
    await this.hook(runId, "bounded-analysis");
    return this.infer(
      { userId: run.userId, spaceId: run.spaceId, email: "", isDeploymentOwner: false },
      run.botId,
      teamDigest({ runId, executionId }),
      "helper",
      args.name,
      args.task,
      args.instructions ??
        "Analyze the explicit task; report uncertainty and required human decisions. Do not claim to have opened files or executed actions.",
      runId,
    );
  }
  async scenarioMessage(
    actor: Actor,
    botId: string,
    id: string,
    message: string,
    nonce: string,
    runId?: string,
  ) {
    safeText(8000).pipe(z.string().trim().min(1)).parse(message);
    const payload = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"scenario:" + id}, 0))`;
      const row = await this.row(actor, botId, id, "scenario", tx as PrismaClient);
      const current = row.payload as any;
      const old = current.messages.find((m: any) => m.nonce === nonce);
      if (old) {
        if (old.question !== message) throw new Error("Scenario replay changed");
        return { ...current, replay: old };
      }
      if (current.activeNonce) throw new Error("Scenario analysis already active");
      if (current.messages.length >= 12) throw new Error("Scenario conversation cap");
      const next = { ...current, activeNonce: nonce };
      await tx.agentWorkbenchRecord.update({
        where: { id },
        data: { status: "analyzing", payload: json(next), digest: teamDigest(next) },
      });
      return next;
    });
    if (payload.replay)
      return {
        name: payload.title,
        text: payload.replay.answer,
        needsApproval: payload.replay.needsApproval,
        replayed: true,
        solveStarted: false,
        policyApprovalGranted: false,
      };
    if (payload.messages.length >= 12)
      throw new Error("Scenario conversation cap; create a new explicit branch");
    try {
      const result = await this.infer(
        actor,
        botId,
        teamDigest({ scenario: id, nonce }),
        "scenario_call",
        payload.title,
        JSON.stringify({
          untrustedHistoricalContext: payload.context,
          priorScenarioDiscussion: payload.messages,
          currentQuestion: message,
        }),
        "Compare this scenario using only supplied facts. This is a separate analysis-only branch. No files, rules, approvals, compute allowances or active solves change.",
        runId,
      );
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"scenario:" + id}, 0))`;
        const fresh = await this.row(actor, botId, id, "scenario", tx as PrismaClient);
        const current = fresh.payload as any;
        if (current.activeNonce !== nonce) throw new Error("Scenario claim changed");
        if (!current.messages.some((m: any) => m.nonce === nonce)) {
          delete current.activeNonce;
          const updated = {
            ...current,
            messages: [
              ...current.messages,
              {
                nonce,
                question: message,
                answer: result.text,
                needsApproval: result.needsApproval,
              },
            ],
          };
          if (Buffer.byteLength(JSON.stringify(updated)) > 180000)
            throw new Error("Scenario context cap");
          await tx.agentWorkbenchRecord.update({
            where: { id },
            data: { payload: json(updated), digest: teamDigest(updated), status: "discussion" },
          });
        }
      });
      return result;
    } catch (error) {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"scenario:" + id}, 0))`;
        const row = await tx.agentWorkbenchRecord.findFirst({
          where: { ...this.where(actor, botId), id, kind: "scenario" },
        });
        const current = row?.payload as any;
        if (current?.activeNonce === nonce) {
          delete current.activeNonce;
          await tx.agentWorkbenchRecord.update({
            where: { id },
            data: { status: "needs_review", payload: json(current), digest: teamDigest(current) },
          });
        }
      });
      throw error;
    }
  }
  async agent(runId: string, key: string, raw: unknown) {
    const input = WorkbenchToolInput.parse(raw);
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== "running") throw new Error("Live turn required");
    const actor = { userId: run.userId, spaceId: run.spaceId, email: "", isDeploymentOwner: false };
    await this.hook(runId, "private-owner");
    if (input.operation === "current") return this.view(actor, run.botId);
    if (!["user", "follow_up"].includes(run.trigger))
      throw new Error("A direct human turn is required for workspace proposals");
    if (input.operation === "propose_goal") {
      const id = stableId(teamDigest({ runId, key, kind: "goal_proposal" }));
      const payload = {
        objective: input.objective,
        policyApprovalGranted: false,
        solveStarted: false,
      };
      const old = await this.db.agentWorkbenchRecord.findUnique({ where: { id } });
      if (old && old.digest !== teamDigest(payload))
        throw new Error("Goal proposal replay changed");
      if (!old) await this.create(actor, run.botId, "goal_proposal", payload, { id, runId });
      return {
        id,
        objective: input.objective,
        reviewUrl: `/app/${run.botId}?workbench=goals&review=${id}`,
        changed: false,
        action: "Ask the user to save the goal in their own browser",
      };
    }
    if (input.operation === "propose_change")
      return this.proposeChange(
        actor,
        run.botId,
        input.path,
        input.proposedText,
        runId,
        runId + ":" + key,
      );
    if (input.operation === "create_scenario") {
      const row = await this.scenario(actor, run.botId, input.title, runId + ":" + key);
      return {
        id: row.id,
        reviewUrl: `/app/${run.botId}?workbench=scenarios&review=${row.id}`,
        authority: "analysis_only",
      };
    }
    return this.scenarioMessage(
      actor,
      run.botId,
      input.id,
      input.message,
      runId + ":" + key,
      runId,
    );
  }
}
