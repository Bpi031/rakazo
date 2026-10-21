// Only an empty, disposable, isolated database; no real accounts, model or solver.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, createRepos, sendUserMessage } from "@rakazo/db";
import { RunTriggerSchema } from "@rakazo/contracts";
import { TeamWorkflowService } from "./team-workflows.js";
import { TeamLeadershipService } from "./team-leadership.js";
import { workbenchChecks } from "./agent-workbench-postgres-checks.js";
import { nativeChecks } from "./native-postgres-checks.js";
const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (
  process.env.ROST_DISPOSABLE_WORKFLOWS_DB !== "1" ||
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.pathname !== "/rost_workflows_test"
)
  throw new Error("Explicit isolated disposable workflow DB required");
process.env.CODEX_DEPLOYMENTS = "test-model";
process.env.TEAM_MESSAGING_ENABLED = "1";
const { prisma: db, pool } = createDb(url.toString());
let checks = 0;
const ok = (value: unknown) => {
  assert.ok(value);
  checks++;
};
const reject = async (work: Promise<unknown>) => {
  await assert.rejects(work);
  checks++;
};
try {
  assert.equal(await db.user.count(), 0);
  assert.equal(await db.teamWorkflow.count(), 0);
  const org = "wf-" + randomUUID();
  const foreign = org + "-other";
  await db.organization.create({
    data: { id: org, slug: org, name: "Offline workflow fixture", createdAt: new Date() },
  });
  await db.organization.create({
    data: { id: foreign, slug: foreign, name: "Other", createdAt: new Date() },
  });
  const actors = [];
  const bots = [];
  for (const n of [0, 1, 2, 3]) {
    const userId = org + "-u" + n;
    const spaceId = org + "-s" + n;
    const organizationId = n === 3 ? foreign : org;
    await db.user.create({
      data: {
        id: userId,
        name: "Fixture " + n,
        email: userId + "@example.invalid",
        emailVerified: true,
      },
    });
    await db.member.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId,
        role: n === 0 || n === 3 ? "owner" : "member",
        createdAt: new Date(),
      },
    });
    await db.space.create({
      data: { id: spaceId, organizationId, name: "Private fixture", createdByUserId: userId },
    });
    await db.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId,
        spaceId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const actor = { userId, spaceId, email: "", isDeploymentOwner: false };
    actors.push(actor);
    bots.push(
      await createRepos(db).createBot(actor, {
        name: "Fixture " + n,
        title: "",
        description: "",
        instructions: "PRIVATE INSTRUCTION MUST NOT BE SHARED",
        notifyOnFinish: false,
        computerMode: "dedicated",
      }),
    );
  }
  const [manager, member, second, outsider] = actors;
  const [lead, peer, peer2, foreignBot] = bots;
  const jobs = { enqueue: async (_job: unknown) => {} };
  const generated: unknown[] = [];
  const service = new TeamWorkflowService(db, jobs, async (input) => {
    generated.push(input);
    return {
      text: "Explicit shared result for " + input.botId,
      needsApproval: false,
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        total_tokens: 15,
      },
    };
  });
  const definition = {
    name: "Collect department facts",
    leadBotId: lead!.id,
    modelId: "test-model",
    objective: "Consolidate provided messages; request a human decision before any change",
    participants: [
      { botId: peer!.id, instruction: "Summarize only the supplied text" },
      { botId: peer2!.id, instruction: "Check completeness of the supplied text" },
    ],
    allowParticipantStart: true,
    maxStartsPerDay: 3,
    maxOutputTokens: 512,
    grantDays: 7,
  };
  await reject(service.propose(member!, definition));
  await reject(service.propose(manager!, { ...definition, leadBotId: foreignBot!.id }));
  await reject(
    service.propose(manager!, {
      ...definition,
      participants: [{ botId: foreignBot!.id, instruction: "x" }],
    }),
  );
  const flow = await service.propose(manager!, definition, "stable-proposal");
  ok((await service.propose(manager!, definition, "stable-proposal")).id === flow.id);
  await reject(service.propose(manager!, { ...definition, name: "Changed" }, "stable-proposal"));
  ok((await service.list(outsider!)).length === 0);
  await reject(service.decide(member!, flow.id, flow.digest, "enable"));
  await reject(service.decide(outsider!, flow.id, flow.digest, "consent"));
  await reject(service.decide(manager!, flow.id, "d".repeat(64), "enable"));
  await service.decide(manager!, flow.id, flow.digest, "enable");
  checks++;
  await reject(
    service.start(manager!, lead!.id, flow.id, "Explicit shared data", "before-consent"),
  );
  await service.decide(member!, flow.id, flow.digest, "consent");
  await reject(
    service.start(manager!, lead!.id, flow.id, "Explicit shared data", "partial-consent"),
  );
  await service.decide(second!, flow.id, flow.digest, "consent");
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      service.start(manager!, lead!.id, flow.id, "Explicit shared data", "same-start"),
    ),
  );
  ok(new Set(attempts.map((e) => e.id)).size === 1);
  let execution = await db.teamWorkflowExecution.findUniqueOrThrow({
    where: { id: attempts[0]!.id },
  });
  ok(execution.runIds.length === 2);
  await reject(service.start(manager!, lead!.id, flow.id, "Changed input", "same-start"));
  await reject(service.start(manager!, lead!.id, flow.id, "Concurrent", "other-start"));
  await reject(
    service.start(outsider!, foreignBot!.id, flow.id, "Unauthorized", "other-org", true),
  );
  const initialRuns = [...execution.runIds];
  const workflowRun = await db.run.findUniqueOrThrow({ where: { id: initialRuns[0]! } });
  ok(RunTriggerSchema.parse(workflowRun.trigger) === "team_workflow");
  const personal = await sendUserMessage(db, {
    spaceId: member!.spaceId,
    userId: member!.userId,
    botId: peer!.id,
    threadId: workflowRun.threadId,
    trigger: "user",
    prompt: "Private unrelated request",
    blocks: [{ kind: "text", text: "Private unrelated request" }],
  });
  ok(Boolean(personal.runId) && !initialRuns.includes(personal.runId!));
  await db.run.update({ where: { id: personal.runId! }, data: { status: "cancelled" } });
  await db.task.update({ where: { id: personal.taskId! }, data: { status: "cancelled" } });
  await service.continueRun(initialRuns[0]!);
  checks++;
  const peerView = (await service.list(member!))[0]!;
  ok(peerView.executions[0]!.steps.every((s) => s.botId === peer!.id));
  await service.continueRun(initialRuns[0]!);
  ok(generated.length === 1);
  await service.continueRun(initialRuns[1]!);
  execution = await db.teamWorkflowExecution.findUniqueOrThrow({ where: { id: execution.id } });
  ok(execution.runIds.length === 3);
  await service.continueRun(execution.runIds[2]!);
  execution = await db.teamWorkflowExecution.findUniqueOrThrow({ where: { id: execution.id } });
  ok(execution.status === "completed");
  ok(generated.length === 3 && !JSON.stringify(generated).includes("PRIVATE INSTRUCTION"));
  ok((await db.usageRecord.count({ where: { callId: { startsWith: "workflow:" } } })) === 3);
  const submission = await service.start(
    member!,
    peer!.id,
    flow.id,
    "Member explicitly shared facts",
    "member-submission",
    true,
  );
  checks++;
  await service.decide(second!, flow.id, flow.digest, "revoke");
  execution = await db.teamWorkflowExecution.findUniqueOrThrow({ where: { id: submission.id } });
  ok(execution.status === "needs_review");
  ok((await db.run.count({ where: { id: { in: execution.runIds }, status: "cancelled" } })) === 2);
  await reject(service.start(member!, peer!.id, flow.id, "No consent", "revoked", true));
  await service.decide(second!, flow.id, flow.digest, "consent");
  const paused = await service.start(manager!, lead!.id, flow.id, "Pause test", "pause-test");
  await service.decide(manager!, flow.id, flow.digest, "pause");
  await service.continueRun(
    (await db.teamWorkflowExecution.findUniqueOrThrow({ where: { id: paused.id } })).runIds[0]!,
  );
  ok(generated.length === 3);
  await service.decide(manager!, flow.id, flow.digest, "enable");
  await reject(service.start(manager!, lead!.id, flow.id, "Daily limit", "fourth-start"));
  const sensitive = await service.propose(manager!, {
    ...definition,
    name: "Approval boundary",
    participants: [definition.participants[0]!],
  });
  await service.decide(manager!, sensitive.id, sensitive.digest, "enable");
  await service.decide(member!, sensitive.id, sensitive.digest, "consent");
  const needDecision = new TeamWorkflowService(db, jobs, async () => ({
    text: "A policy change needs the policy owner's decision",
    needsApproval: true,
  }));
  const sensitiveRun = await needDecision.start(
    manager!,
    lead!.id,
    sensitive.id,
    "Change the roster rules and solve",
    "sensitive",
  );
  execution = await db.teamWorkflowExecution.findUniqueOrThrow({ where: { id: sensitiveRun.id } });
  await needDecision.continueRun(execution.runIds[0]!);
  ok(
    (await db.teamWorkflowExecution.findUniqueOrThrow({ where: { id: sensitiveRun.id } }))
      .status === "needs_approval",
  );
  ok(
    (await db.teamWorkflowExecution.findUniqueOrThrow({ where: { id: sensitiveRun.id } })).runIds
      .length === 1,
  );
  const revokeDuring = await service.propose(manager!, {
    ...definition,
    name: "In-flight revocation",
    participants: [definition.participants[0]!],
  });
  await service.decide(manager!, revokeDuring.id, revokeDuring.digest, "enable");
  await service.decide(member!, revokeDuring.id, revokeDuring.digest, "consent");
  const inFlight = new TeamWorkflowService(db, jobs, async () => {
    await service.decide(member!, revokeDuring.id, revokeDuring.digest, "revoke");
    return { text: "MUST NOT BE DELIVERED", needsApproval: false };
  });
  const inflightRun = await inFlight.start(
    manager!,
    lead!.id,
    revokeDuring.id,
    "Explicit input",
    "inflight",
  );
  await inFlight.continueRun(
    (await db.teamWorkflowExecution.findUniqueOrThrow({ where: { id: inflightRun.id } }))
      .runIds[0]!,
  );
  ok(
    !JSON.stringify(await db.message.findMany({ select: { blocks: true } })).includes(
      "MUST NOT BE DELIVERED",
    ),
  );
  const cancelFlow = await service.propose(manager!, {
    ...definition,
    name: "Cancel while generating",
    participants: [definition.participants[0]!],
  });
  await service.decide(manager!, cancelFlow.id, cancelFlow.digest, "enable");
  await service.decide(member!, cancelFlow.id, cancelFlow.digest, "consent");
  const cancelDuring = new TeamWorkflowService(db, jobs, async (input) => {
    await db.run.update({ where: { id: input.runId }, data: { status: "cancelled" } });
    return { text: "CANCELLED OUTPUT MUST NOT BE DELIVERED", needsApproval: false };
  });
  const cancelled = await cancelDuring.start(
    manager!,
    lead!.id,
    cancelFlow.id,
    "Shared",
    "cancelled",
  );
  const cancelledExecution = await db.teamWorkflowExecution.findUniqueOrThrow({
    where: { id: cancelled.id },
  });
  await cancelDuring.continueRun(cancelledExecution.runIds[0]!);
  ok(
    (await db.run.findUniqueOrThrow({ where: { id: cancelledExecution.runIds[0]! } })).status ===
      "cancelled",
  );
  ok(
    (await db.teamWorkflowExecution.findUniqueOrThrow({ where: { id: cancelled.id } })).status ===
      "needs_review",
  );
  ok(
    !JSON.stringify(await db.message.findMany({ select: { blocks: true } })).includes(
      "CANCELLED OUTPUT MUST NOT BE DELIVERED",
    ),
  );
  const changed = await service.propose(manager!, { ...definition, name: "Role drift" });
  await service.decide(manager!, changed.id, changed.digest, "enable");
  await db.member.update({
    where: { organizationId_userId: { organizationId: org, userId: member!.userId } },
    data: { role: "admin" },
  });
  await reject(service.decide(member!, changed.id, changed.digest, "consent"));
  ok((await service.list(manager!)).find((f) => f.id === changed.id)?.ready === false);
  const leadership = new TeamLeadershipService(db, async () => []);
  const transfer = await leadership.propose(
    member!,
    peer!.id,
    { successorBotId: peer2!.id, workflowIds: [] },
    "manager-shift",
  );
  await reject(leadership.decide(second!, transfer.id, transfer.digest, "accept"));
  await reject(leadership.decide(outsider!, transfer.id, transfer.digest, "accept"));
  await reject(leadership.decide(second!, transfer.id, transfer.digest, "offer"));
  await leadership.decide(member!, transfer.id, transfer.digest, "offer");
  checks++;
  ok((await leadership.list(second!))[0]!.status === "offered");
  ok((await leadership.list(outsider!)).length === 0);
  await leadership.decide(second!, transfer.id, transfer.digest, "accept");
  checks++;
  ok(
    (
      await db.member.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: org, userId: member!.userId } },
      })
    ).role === "member",
  );
  ok(
    (
      await db.member.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: org, userId: second!.userId } },
      })
    ).role === "admin",
  );
  ok((await db.bot.findUniqueOrThrow({ where: { id: peer!.id } })).userId === member!.userId);
  ok((await leadership.decide(second!, transfer.id, transfer.digest, "accept")) as any);
  const successorLead = await createRepos(db).createBot(second!, {
    name: "Successor lead",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
    computerMode: "dedicated",
  });
  const ownerTransfer = await leadership.propose(
    manager!,
    lead!.id,
    { successorBotId: successorLead.id, workflowIds: [changed.id] },
    "owner-delegation",
  );
  await leadership.decide(manager!, ownerTransfer.id, ownerTransfer.digest, "offer");
  await leadership.decide(second!, ownerTransfer.id, ownerTransfer.digest, "accept");
  ok(
    (
      await db.member.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: org, userId: manager!.userId } },
      })
    ).role === "owner",
  );
  const transferred = await db.teamLeadershipTransfer.findUniqueOrThrow({
    where: { id: ownerTransfer.id },
  });
  const copies = (transferred.result as any).newWorkflows;
  ok(copies.length === 1);
  const copy = await db.teamWorkflow.findUniqueOrThrow({ where: { id: copies[0] } });
  ok(copy.managerUserId === second!.userId && copy.status === "draft");
  ok(JSON.stringify(copy.consents) === "{}");
  ok((await db.teamWorkflowExecution.count({ where: { workflowId: copy.id } })) === 0);
  ok((await db.teamWorkflow.findUniqueOrThrow({ where: { id: changed.id } })).status === "paused");
  const workbench = await workbenchChecks(db, member!, manager!, peer!.id);
  const native = await nativeChecks(db,member!,manager!,peer!.id);
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      workbench_checks: workbench,
      native_checks: native,
      native_postgres: true,
      provider_request_sent: false,
      solver_started: false,
      license_read: false,
    }),
  );
} finally {
  await db.$disconnect();
  await pool.end();
}
