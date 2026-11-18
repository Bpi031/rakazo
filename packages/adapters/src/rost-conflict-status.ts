import { Prisma, type PrismaClient } from '@rakazo/db';
import type { SandboxProvider } from '@rakazo/adapter-kit';
import { observeRostJob, RostJobOut, RostJobObservationError } from './rost-job-watch.js';
import { memberScope } from './team-storage.js';
import { managerRole, teamDigest } from './team-policy.js';

type Deps = { prisma: PrismaClient; sandbox: SandboxProvider };
type Run = { botId: string; userId: string; spaceId: string; threadId: string;
  trigger: string; routineId: string | null };
type Data = Record<string, any>;

/** Read an owned result or legacy checkpoint; never reserve or start diagnosis. */
export async function readRostConflictStatus(deps: Deps, run: Run) {
  const inactive = { status: 'no_current_conflict', solveStarted: false, computeAllowanceGranted: false,
    action: 'No current owned proved-infeasible watch. Inspect the owned job and any saved diagnosis.' };
  if (!['user', 'follow_up', 'routine'].includes(run.trigger)) return inactive;
  const scope = { userId: run.userId, spaceId: run.spaceId, botId: run.botId };
  if (!managerRole((await memberScope(deps.prisma, scope.userId, scope.spaceId)).role)) return inactive;
  const thread = { ...scope, threadId: run.threadId };
  const routine = run.routineId
    ? await deps.prisma.routine.findFirst({ where: { ...thread, id: run.routineId } })
    : await deps.prisma.routine.findFirst({ where: { ...thread, jobWatch: { not: Prisma.DbNull } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const watch = routine?.jobWatch as Data | null;
  if (!watch || watch.schema !== 'rost/job-watch/v1') return inactive;
  const out = RostJobOut.parse(watch.out);
  let observation;
  try {
    observation = await observeRostJob(deps, scope, out);
  } catch (error) {
    if (!(error instanceof RostJobObservationError)) throw error;
    return { status: 'observation_unavailable', solveStarted: false, computeAllowanceGranted: false,
      action: 'Could not read the exact owned result. This status check starts no new numerical work.' };
  }
  if (observation.binding !== watch.binding || observation.computerId !== watch.computerId
      || observation.deadlineUtc !== watch.deadlineUtc || observation.threadId !== run.threadId)
    throw new Error('Conflict job identity changed');
  if (observation.outcome !== 'proven_infeasible') return inactive;
  const id = teamDigest({ ...scope, binding: watch.binding, kind: 'rost_conflict_loop' });
  const existing = await deps.prisma.agentWorkbenchRecord.findUnique({ where: { id } });
  if (!existing) return { status: 'not_diagnosed', outcome: observation.outcome, out,
    binding: watch.binding, deadlineUtc: watch.deadlineUtc, solveStarted: false, computeAllowanceGranted: false };
  if (existing.kind !== 'rost_conflict_loop' || existing.userId !== run.userId || existing.botId !== run.botId
      || existing.spaceId !== run.spaceId || existing.digest !== teamDigest(existing.payload))
    throw new Error('Conflict checkpoint changed');
  const payload = existing.payload as Data;
  if (payload.binding !== watch.binding || payload.out !== out || payload.deadlineUtc !== watch.deadlineUtc)
    throw new Error('Conflict checkpoint job changed');
  return { ...payload, id, status: existing.status, solveStarted: false, computeAllowanceGranted: false };
}
