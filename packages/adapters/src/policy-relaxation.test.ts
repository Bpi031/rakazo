import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { PolicyWorkflow } from "./policy/policy-workflow.js";
import { teamDigest } from "./teams/team-policy.js";

const actor = {
  userId: "u",
  spaceId: "s",
  email: "synthetic@example.invalid",
  isDeploymentOwner: false,
};
const flowId = "f".repeat(64);
const request = {
  operation: "relaxation_review",
  flowId,
  policy: "workspace/case/policy.rost",
  workingDirectory: "workspace/case",
  proposal: "workspace/case/change.rostrelax",
  seconds: 15,
  reason: "Selected bounded exception",
};
type Row = {
  id: string;
  userId: string;
  spaceId: string;
  botId: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  digest: string;
  expiresAt?: Date;
};
type Lookup = {
  id: string;
  userId?: string;
  spaceId?: string;
  kind?: string;
  status?: string | { in: string[] };
};
const reviewed = z.object({ id: z.string() });
let records: Map<string, Row>,
  service: PolicyWorkflow,
  snapshot: {
    candidate: { sourceSha256: string };
    baseline: { sourceSha256: string };
    expiresAt: string;
  },
  execute: ReturnType<typeof vi.fn<SandboxProvider["execute"]>>,
  calls: string[];
beforeEach(() => {
  calls = [];
  records = new Map();
  const payload = {
    deadlineUtc: Date.now() / 1000 + 3600,
    diagnosisId: "d".repeat(64),
    diagnosis: {
      status: "infeasible",
      policy: request.policy,
      workingDirectory: request.workingDirectory,
      evidenceSha256: "e".repeat(64),
    },
  };
  records.set(flowId, {
    id: flowId,
    userId: "u",
    spaceId: "s",
    botId: "b",
    kind: "rost_conflict_loop",
    status: "waiting_decision",
    payload,
    digest: teamDigest(payload),
  });
  snapshot = {
    candidate: { sourceSha256: "a".repeat(64) },
    baseline: { sourceSha256: "a".repeat(64) },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const db = {
    spaceMember: { findUnique: async () => ({ organizationId: "org", member: { role: "admin" } }) },
    teamMemberControl: { findUnique: async () => null },
    bot: {
      findFirstOrThrow: async () => ({
        computerId: "c",
        computer: {
          id: "c",
          state: "running",
          scope: "dedicated",
          kind: "docker",
          providerRef: "private",
        },
      }),
    },
    run: {
      findUniqueOrThrow: async () => ({
        status: "running",
        trigger: "follow_up",
        ...actor,
        botId: "b",
      }),
    },
    agentWorkbenchRecord: {
      findUnique: async ({ where }: { where: Lookup }) => records.get(where.id),
      findFirstOrThrow: async ({ where }: { where: Lookup }) => {
        const row = records.get(where.id);
        if (
          !row ||
          row.userId !== where.userId ||
          row.spaceId !== where.spaceId ||
          row.kind !== where.kind
        )
          throw Error("private");
        return structuredClone(row);
      },
      create: async ({ data }: { data: Row }) => {
        if (records.has(data.id)) throw Error("duplicate");
        records.set(data.id, structuredClone(data));
        return data;
      },
      updateMany: async ({ where, data }: { where: Lookup; data: Partial<Row> }) => {
        const row = records.get(where.id);
        if (
          !row ||
          (typeof where.status === "string" && row.status !== where.status) ||
          (typeof where.status === "object" && !where.status.in.includes(row.status))
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    teamAudit: { create: vi.fn(async () => ({})) },
  };
  const prisma = Object.assign(db, {
    $transaction: <T>(fn: (tx: typeof db) => Promise<T>) => fn(db),
  });
  execute = vi.fn<SandboxProvider["execute"]>(async function* (_ref, req) {
    const input = JSON.parse(Buffer.from(req.argv.at(-2)!, "base64").toString());
    calls.push(input.operation);
    if (input.operation === "apply_relaxation")
      expect(input.receipt).toMatchObject({
        subject: "u",
        decision: "approve",
        scope: "exact_native_relaxation",
      });
    yield {
      type: "stdout",
      data: JSON.stringify(
        input.operation === "apply_relaxation"
          ? { status: "applied", solveStarted: false }
          : snapshot,
      ),
    };
    yield { type: "exit", code: 0 };
  });
  service = new PolicyWorkflow({ prisma: prisma as unknown as PrismaClient, sandbox: { execute } });
});
it("requires an exact manager review before applying, with no password or solve", async () => {
  const review = reviewed.parse(await service.agent("r", "review", request));
  await expect(service.agent("r", "apply", { operation: "apply", id: review.id })).rejects.toThrow(
    "decision",
  );
  const visible = await service.get(actor, review.id!);
  expect(await service.decide(actor, visible.id, visible.digest, "approve")).toMatchObject({
    relaxationAuthorityGranted: true,
    computeAllowanceGranted: false,
  });
  expect(await service.agent("r", "apply", { operation: "apply", id: visible.id })).toMatchObject({
    status: "applied",
    solveStarted: false,
  });
  const count = calls.length;
  await service.agent("r", "retry", { operation: "apply", id: visible.id });
  expect(calls).toHaveLength(count);
  expect(calls.filter((c) => c === "apply_relaxation")).toHaveLength(1);
});
it.each(["source", "expiry", "rejection"])(
  "refuses %s change before exact application",
  async (mode) => {
    const proposed = reviewed.parse(await service.agent("r", "review", request));
    const review = await service.get(actor, proposed.id!);
    await service.decide(
      actor,
      review.id,
      review.digest,
      mode === "rejection" ? "reject" : "approve",
    );
    if (mode === "source") snapshot.baseline.sourceSha256 = "b".repeat(64);
    if (mode === "expiry") records.get(review.id)!.expiresAt = new Date(0);
    await expect(
      service.agent("r", "apply", { operation: "apply", id: review.id }),
    ).rejects.toThrow();
    expect(calls).not.toContain("apply_relaxation");
  },
);
it("claims finite review once, including different proposal names on the same conflict", async () => {
  await service.agent("r", "review", request);
  const count = calls.length;
  await service.agent("r", "again", request);
  expect(calls).toHaveLength(count);
  await expect(
    service.agent("r", "changed", { ...request, proposal: "workspace/case/other.rostrelax" }),
  ).rejects.toThrow("reservation");
});
it("refuses expired budget before running numerical review", async () => {
  const row = records.get(flowId)!;
  row.payload.deadlineUtc = Date.now() / 1000;
  row.digest = teamDigest(row.payload);
  await expect(service.agent("r", "review", request)).rejects.toThrow("allowance");
  expect(execute).not.toHaveBeenCalled();
});
