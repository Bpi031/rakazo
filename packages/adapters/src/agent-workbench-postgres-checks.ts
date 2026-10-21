import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { answerRunInput, deferSteering, type PrismaClient } from "@rakazo/db";
import type { Actor } from "@rakazo/contracts";
import { AgentWorkbench } from "./agent-workbench.js";

export async function workbenchChecks(db: PrismaClient, actor: Actor, other: Actor, botId: string) {
  let checks = 0,
    generated = 0;
  const ok = (v: unknown) => {
    assert.ok(v);
    checks++;
  };
  const reject = async (p: Promise<unknown>) => {
    await assert.rejects(p);
    checks++;
  };
  const bot = await db.bot.findUniqueOrThrow({ where: { id: botId }, include: { thread: true } });
  assert.ok(bot.thread);
  const computer = await db.computer.create({
    data: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      scope: "dedicated",
      scopeKey: randomUUID(),
      homeKey: randomUUID(),
      kind: "docker",
      providerRef: "offline-fixture",
      state: "running",
    },
  });
  await db.bot.update({
    where: { id: botId },
    data: { computerId: computer.id, modelId: "test-model", modelProvider: "codex-foundry" },
  });
  const installed = {
    id: "a".repeat(64),
    name: "Office",
    path: "/opt/team/office/skills/office/SKILL.md",
    description: "Reviewed office",
    sha256: "b".repeat(64),
  };
  const commands: any[] = [],
    modelInputs: any[] = [];
  const service = new AgentWorkbench({
    prisma: db,
    sandbox: {
      async *execute(_computer: unknown, command: any) {
        const input = JSON.parse(Buffer.from(command.argv[4], "base64").toString());
        commands.push(input);
        yield {
          type: "stdout",
          data: JSON.stringify(
            input.operation === "skills"
              ? { skills: [installed] }
              : input.operation === "capture"
                ? { path: input.path, before: "unchanged source", sourceSha256: "c".repeat(64) }
                : {
                    draftPath: "workspace/policy.review.rost",
                    policyApprovalGranted: false,
                    solveStarted: false,
                  },
          ),
        };
        yield { type: "exit", code: 0 };
      },
    } as any,
    generate: async (input) => {
      generated++;
      modelInputs.push(input);
      return {
        text: "Independent analysis result",
        needsApproval: true,
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens: 4,
          total_tokens: 16,
        },
      };
    },
  });
  const run = async () => {
    const task = await db.task.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId,
        threadId: bot.thread!.id,
        prompt: "Offline request",
        status: "queued",
      },
    });
    return db.run.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId,
        threadId: bot.thread!.id,
        taskId: task.id,
        trigger: "user",
        status: "running",
        leaseOwner: "offline-worker",
        leaseFence: 1,
        modelId: "test-model",
        modelProvider: "codex-foundry",
      },
    });
  };
  await reject(service.view(other, botId));
  await service.goal(actor, botId, 0, { objective: "Inspect draft", status: "active" });
  checks++;
  await reject(service.goal(actor, botId, 0, { objective: "Stale update", status: "active" }));
  const first = await run();
  await service.hook(first.id, "private-owner");
  await service.hook(first.id, "private-owner");
  ok((await db.agentWorkbenchRecord.count({ where: { runId: first.id, kind: "hook" } })) === 1);
  await reject(service.hook(first.id, "user-shell-hook"));
  const goal = await service.agent(first.id, "goal", {
    operation: "propose_goal",
    objective: "Compare weekend balance",
  });
  ok((goal as any).changed === false && (goal as any).id);
  ok(((await service.view(actor, botId)).goal as any).objective === "Inspect draft");
  await reject(
    service.agent(first.id, "goal", { operation: "propose_goal", objective: "Different replay" }),
  );
  const helper = await service.helper(first.id, "h1", {
    name: "Review",
    task: "Check supplied totals",
  });
  ok(helper.text !== "Check supplied totals" && helper.needsApproval && !helper.solveStarted);
  await service.helper(first.id, "h1", { name: "Review", task: "Check supplied totals" });
  ok(generated === 1);
  await reject(service.helper(first.id, "h1", { name: "Review", task: "Changed" }));
  await reject(
    service.helper(first.id, "different-provider", {
      name: "Review",
      task: "Check",
      model_provider: "other",
    }),
  );
  await service.helper(first.id, "h2", { name: "Review", task: "Check facts" });
  await service.helper(first.id, "h3", { name: "Review", task: "Check uncertainty" });
  await reject(service.helper(first.id, "h4", { name: "Review", task: "More" }));
  ok(
    (await db.usageRecord.count({
      where: { runId: first.id, usageSource: "workbench-protected-route" },
    })) === 3,
  );
  ok(modelInputs.every((i) => !JSON.stringify(i).includes("PRIVATE INSTRUCTION")));
  const usage = await db.usageRecord.findFirstOrThrow({ where: { runId: first.id } });
  ok(usage.inputTokens === 10 && usage.cacheReadTokens === 2 && usage.outputTokens === 4);
  const proposal = await service.proposeChange(
    actor,
    botId,
    "workspace/policy.rost",
    "draft bytes",
    first.id,
    "effect1",
  );
  const replay = await service.proposeChange(
    actor,
    botId,
    "workspace/policy.rost",
    "draft bytes",
    first.id,
    "effect1",
  );
  ok(proposal.id === replay.id && commands.filter((c) => c.operation === "capture").length === 1);
  await reject(
    service.proposeChange(
      actor,
      botId,
      "workspace/policy.rost",
      "other bytes",
      first.id,
      "effect1",
    ),
  );
  await reject(service.saveDraft(other, botId, proposal.id, proposal.digest));
  await reject(service.saveDraft(actor, botId, proposal.id, "d".repeat(64)));
  ok(commands.filter((c) => c.operation === "save").length === 0);
  const saved = await service.saveDraft(actor, botId, proposal.id, proposal.digest);
  ok(saved.draftPath === "workspace/policy.review.rost");
  ok((await db.agentWorkbenchRecord.count({ where: { botId, kind: "draft_receipt" } })) === 1);
  await service.skills(actor, botId);
  await service.selectSkill(actor, botId, installed.id);
  const context = await service.turnContext(first.id);
  ok(context.selectedSkill?.path === installed.path);
  ok((await service.turnContext(first.id)).selectedSkill === undefined);
  await reject(service.selectSkill(actor, botId, "d".repeat(64)));
  const scenario = await service.scenario(actor, botId, "Alternate weekends", "stable-scenario");
  ok(
    (await service.scenario(actor, botId, "Alternate weekends", "stable-scenario")).id ===
      scenario.id,
  );
  await reject(service.scenario(actor, botId, "Different", "stable-scenario"));
  ok(!JSON.stringify(scenario.payload).includes("PRIVATE INSTRUCTION"));
  await reject(service.detail(other, botId, scenario.id));
  const answer = await service.scenarioMessage(actor, botId, scenario.id, "Compare", "nonce");
  const count = generated;
  ok(
    (await service.scenarioMessage(actor, botId, scenario.id, "Compare", "nonce")).text ===
      answer.text && generated === count,
  );
  await reject(service.scenarioMessage(actor, botId, scenario.id, "Different", "nonce"));
  ok((await service.detail(actor, botId, scenario.id)).status === "discussion");
  let unblock!: () => void, started!: () => void;
  const startedGate = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    unblock = r;
  });
  const pendingService = new AgentWorkbench({
    prisma: db,
    generate: async () => {
      started();
      await gate;
      return { text: "Bounded", needsApproval: false };
    },
  });
  const pending = pendingService.scenarioMessage(actor, botId, scenario.id, "One analysis", "n2");
  await startedGate;
  await reject(pendingService.scenarioMessage(actor, botId, scenario.id, "Concurrent", "n3"));
  unblock();
  await pending;
  checks++;
  const cancelled = await run();
  const cancellationService = new AgentWorkbench({
    prisma: db,
    generate: async () => {
      await db.run.update({ where: { id: cancelled.id }, data: { status: "cancelled" } });
      return {
        text: "Do not deliver",
        needsApproval: false,
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      };
    },
  });
  await reject(
    cancellationService.helper(cancelled.id, "cancel", { name: "Cancel", task: "Explicit" }),
  );
  ok((await db.usageRecord.count({ where: { runId: cancelled.id } })) === 1);
  ok(
    (
      await db.agentWorkbenchRecord.findFirstOrThrow({
        where: { runId: cancelled.id, kind: "helper" },
      })
    ).status === "needs_review",
  );
  await reject(service.hook(cancelled.id, "finish-boundary"));
  // A late native steering claim is returned before parent finalization, never silently discarded.
  const message = await db.message.create({
    data: {
      threadId: bot.thread!.id,
      role: "user",
      seq: 9000,
      blocks: [{ kind: "text", text: "Next response" }],
    },
  });
  const steering = await db.steeringMessage.create({
    data: {
      botId,
      runId: first.id,
      userId: actor.userId,
      messageId: message.id,
      claimedAt: new Date(),
    },
  });
  const scoped = {
    threadId: bot.thread!.id,
    botId,
    runId: first.id,
    leaseOwner: "offline-worker",
    leaseFence: 1,
    seenIds: [],
    ids: [steering.id],
  };
  await deferSteering(db, { ...scoped, leaseFence: 2 });
  ok(
    (await db.steeringMessage.findUniqueOrThrow({ where: { id: steering.id } })).runId === first.id,
  );
  await deferSteering(db, scoped);
  ok(
    (await db.steeringMessage.findUniqueOrThrow({ where: { id: steering.id } })).claimedAt === null,
  );
  // Actual durable answer operation validates fields and exact owner before resuming the task.
  await db.steeringMessage.update({ where: { id: steering.id }, data: { runId: first.id, claimedAt: new Date() } });
  await db.run.update({ where: { id: first.id }, data: { status: "waiting_input", leaseOwner: null } });
  await deferSteering(db, scoped);
  ok((await db.steeringMessage.findUniqueOrThrow({ where: { id: steering.id } })).runId === null);
  const waiting = await run();
  await db.run.update({ where: { id: waiting.id }, data: { status: "waiting_input" } });
  const ask = await db.message.create({
    data: {
      threadId: bot.thread!.id,
      role: "bot",
      runId: waiting.id,
      seq: 9001,
      blocks: [
        {
          kind: "ask",
          text: "Select amount",
          status: "pending",
          form: {
            schema: "rakazo/question-form/v1",
            fields: [{ id: "cost", label: "Cost", type: "number", min: 0, max: 5, required: true }],
          },
        },
      ],
    },
  });
  const answerInput = {
    spaceId: actor.spaceId,
    threadId: bot.thread!.id,
    runId: waiting.id,
    messageId: ask.id,
    answeredByUserId: actor.userId,
    answer: JSON.stringify({ schema: "rakazo/question-answer/v1", values: { cost: 2.5 } }),
  };
  ok(!(await answerRunInput(db, { ...answerInput, answeredByUserId: other.userId })));
  ok(
    !(await answerRunInput(db, {
      ...answerInput,
      answer: JSON.stringify({ schema: "rakazo/question-answer/v1", values: { cost: 99 } }),
    })),
  );
  ok((await db.run.findUniqueOrThrow({ where: { id: waiting.id } })).status === "waiting_input");
  ok(await answerRunInput(db, answerInput));
  ok(!(await answerRunInput(db, answerInput)));
  ok(
    !(await db.task.findUniqueOrThrow({ where: { id: waiting.taskId } })).prompt.includes(
      'policyApprovalGranted":true',
    ),
  );
  return checks;
}
