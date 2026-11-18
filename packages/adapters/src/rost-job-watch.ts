import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SandboxProvider, AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { memberScope } from "./team-storage.js";
import { toComputerRef } from "./computer-support.js";

const observer = readFileSync(new URL("./rost-job-observer.py", import.meta.url), "utf8");
export const RostJobOut = z.string().min(1).max(512).refine(
  (value) => !value.startsWith("/") && value !== "workspace" && !value.startsWith("workspace/") && !/[\x00-\x1f\x7f\\]/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "Use an exact path relative to this bot's workspace",
);
const Observation = z.object({
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  deadlineUtc: z.number().finite().positive(),
  status: z.enum(["reserved", "preparing", "starting", "running", "stopping", "checking", "completed", "stopped", "failed", "recovery_required"]),
  observedStatus: z.literal("recovery_required").optional(),
  outcome: z.enum(["running", "proven_infeasible", "candidate_needs_validation", "technical_failure", "no_candidate_unknown"]).optional(),
}).strict();
const Watch = z.object({
  schema: z.literal("rost/job-watch/v1"),
  out: RostJobOut,
  computerId: z.string().min(1),
  binding: Observation.shape.binding,
  deadlineUtc: Observation.shape.deadlineUtc,
  checks: z.number().int().nonnegative(),
  failures: z.number().int().min(0).max(3),
  lastCheckedAt: z.string().optional(),
  lastStatus: z.string().max(64).optional(),
  outcome: Observation.shape.outcome,
  wakeReason: z.enum(["completion", "failure", "required_decision"]).optional(),
}).strict();
type Scope = { userId: string; spaceId: string; botId: string };
type Deps = { prisma: PrismaClient; sandbox?: SandboxProvider };

export class RostJobObservationError extends Error {
  constructor() {
    super("ROST_JOB_WATCH_OBSERVATION: A supported owned-job status could not be read. Check the existing job; do not restart it.");
    this.name = "RostJobObservationError";
  }
}

export async function observeRostJob(deps: Deps, scope: Scope, out: string) {
  await memberScope(deps.prisma, scope.userId, scope.spaceId);
  const bot = await deps.prisma.bot.findFirstOrThrow({
    where: { id: scope.botId, userId: scope.userId, spaceId: scope.spaceId, archivedAt: null },
    include: { computer: true, thread: true },
  });
  if (!bot.thread || !deps.sandbox || bot.computer?.scope !== "dedicated"
      || bot.computer.userId !== scope.userId || bot.computer.spaceId !== scope.spaceId
      || !bot.computer.providerRef || bot.computer.state !== "running")
    throw new Error("Existing owned private running computer required");
  const context: AdapterContext = {
    ...scope, operationId: "rost-watch:" + randomUUID(), traceId: "rost-job-observe",
    signal: AbortSignal.timeout(20_000),
  };
  const relativeOut = RostJobOut.parse(out);
  let value: z.infer<typeof Observation>;
  try {
    let stdout = "", code: number | undefined;
    for await (const event of deps.sandbox.execute(toComputerRef(bot.computer), {
      argv: ["/opt/office-python/bin/python3", "-I", "-c", observer, relativeOut],
      cwd: "/home/rakazo", timeoutMs: 15000,
      unsetEnv: ["PYTHONPATH", "PYTHONHOME", "LD_PRELOAD"],
    }, context)) {
      if (event.type === "stdout") {
        stdout += event.data;
        if (Buffer.byteLength(stdout) > 8192) throw new Error("Observation cap");
      }
      if (event.type === "exit") code = event.code;
    }
    if (code !== 0) throw new Error("Observation unavailable");
    value = Observation.parse(JSON.parse(stdout));
  } catch {
    // This is monitoring evidence, not a provider failure or permission to retry a solve.
    throw new RostJobObservationError();
  }
  // Revocation/reassignment during the read must not deliver into another space.
  await memberScope(deps.prisma, scope.userId, scope.spaceId);
  await deps.prisma.bot.findFirstOrThrow({ where: {
    id: scope.botId, userId: scope.userId, spaceId: scope.spaceId, archivedAt: null,
    computerId: bot.computer.id,
  } });
  return { ...value, computerId: bot.computer.id, threadId: bot.thread.id };
}

export async function createRostJobWatch(deps: Deps, scope: Scope, out: string, threadId?: string | null) {
  out = RostJobOut.parse(out);
  const value = await observeRostJob(deps, scope, out);
  if (threadId && threadId !== value.threadId) throw new Error("A private owned bot thread is required");
  return Watch.parse({ schema: "rost/job-watch/v1", out, computerId: value.computerId,
    binding: value.binding, deadlineUtc: value.deadlineUtc, checks: 0, failures: 0 });
}

export function reduceRostWatch(raw: unknown, observation: unknown, at = new Date()) {
  const previous = Watch.parse(raw);
  if (previous.wakeReason) throw new Error("Watch already consumed; no automatic model retry");
  const parsed = Observation.safeParse(observation);
  const matching = parsed.success && parsed.data.binding === previous.binding
    && parsed.data.deadlineUtc === previous.deadlineUtc;
  const status = matching ? parsed.data.observedStatus ?? parsed.data.status : "observation_unavailable";
  const failures = matching ? 0 : Math.min(3, previous.failures + 1);
  let wakeReason: "completion" | "failure" | "required_decision" | undefined;
  if (failures === 3 || status === "recovery_required") wakeReason = "required_decision";
  else if (status === "failed") wakeReason = "failure";
  else if (status === "completed" || status === "stopped") wakeReason = "completion";
  else if (at.getTime() / 1000 > previous.deadlineUtc + 180) wakeReason = "required_decision";
  return Watch.parse({ ...previous, checks: previous.checks + 1, failures,
    lastCheckedAt: at.toISOString(), lastStatus: status,
    outcome: matching ? parsed.data.outcome : undefined, ...(wakeReason ? { wakeReason } : {}) });
}

export async function pollRostJobWatch(deps: Deps, scope: Scope, raw: unknown) {
  const previous = Watch.parse(raw);
  let value;
  try {
    const current = await observeRostJob(deps, scope, previous.out);
    if (current.computerId === previous.computerId) value = {
      binding: current.binding, deadlineUtc: current.deadlineUtc,
      status: current.status, ...(current.observedStatus ? { observedStatus: current.observedStatus } : {}),
      ...(current.outcome ? { outcome: current.outcome } : {}),
    };
  } catch { /* Bounded transient retries stay token-free; the third failure requests attention. */ }
  return reduceRostWatch(previous, value);
}

export function assertRostWatchTriggers(watch: unknown, input: {
  crons: string[]; webhookEnabled?: boolean; githubEnabled?: boolean; messageProvider?: string | null;
}) {
  if (watch && (!input.crons.length || input.crons.includes("@once") || input.webhookEnabled
      || input.githubEnabled || input.messageProvider))
    throw new Error("Rost watches require recurring timer-only triggers");
}
