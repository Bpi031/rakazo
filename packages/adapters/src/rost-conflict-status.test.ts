import { beforeEach, expect, it, vi } from 'vitest';
import { readRostConflictStatus } from './rost-conflict-status.js';
import { observeRostJob, RostJobObservationError } from './rost-job-watch.js';
import { teamDigest } from './team-policy.js';

vi.mock('./rost-job-watch.js', async () => ({
  ...(await vi.importActual<typeof import('./rost-job-watch.js')>('./rost-job-watch.js')), observeRostJob: vi.fn(),
}));

const run = { userId: 'u', spaceId: 's', botId: 'b', threadId: 't', trigger: 'user', routineId: null };
const scope = { userId: run.userId, spaceId: run.spaceId, botId: run.botId };
const binding = 'a'.repeat(64);
const out = 'case/job';
const deadlineUtc = 1700000000;
const checkpointId = teamDigest({ ...scope, binding, kind: 'rost_conflict_loop' });
const observation = { outcome: 'proven_infeasible', status: 'completed', binding, deadlineUtc,
  computerId: 'c', threadId: 't' } as const;
let role: string;
let deps: Parameters<typeof readRostConflictStatus>[0];
const execute = vi.fn();
const readCheckpoint = vi.fn();
const findWatch = vi.fn();

beforeEach(() => {
  role = 'admin';
  vi.clearAllMocks();
  readCheckpoint.mockResolvedValue(null);
  findWatch.mockResolvedValue({ id: 'watch', jobWatch: { schema: 'rost/job-watch/v1', out, ...observation } });
  vi.mocked(observeRostJob).mockResolvedValue(observation);
  deps = {
    prisma: {
      spaceMember: { findUnique: async () => ({ organizationId: 'org', member: { role } }) },
      teamMemberControl: { findUnique: async () => null },
      routine: { findFirst: findWatch },
      agentWorkbenchRecord: { findUnique: readCheckpoint },
    } as unknown as Parameters<typeof readRostConflictStatus>[0]['prisma'],
    sandbox: { execute } as unknown as Parameters<typeof readRostConflictStatus>[0]['sandbox'],
  };
});

it('reports an undiagnosed proof without launching a diagnostic process or writing a checkpoint', async () => {
  expect(await readRostConflictStatus(deps, run)).toMatchObject({
    status: 'not_diagnosed', outcome: 'proven_infeasible', out, solveStarted: false, computeAllowanceGranted: false,
  });
  expect(readCheckpoint).toHaveBeenCalledWith({ where: { id: checkpointId } });
  expect(execute).not.toHaveBeenCalled();
});

it('keeps an exact legacy checkpoint readable without renewing its authority', async () => {
  const payload = { out, binding, deadlineUtc, diagnosis: { evidencePath: 'workspace/review/diagnosis.json' } };
  readCheckpoint.mockResolvedValue({ ...scope, kind: 'rost_conflict_loop', payload,
    digest: teamDigest(payload), status: 'waiting_decision' });
  expect(await readRostConflictStatus(deps, run)).toMatchObject({
    ...payload, id: checkpointId, status: 'waiting_decision', solveStarted: false, computeAllowanceGranted: false,
  });
  expect(execute).not.toHaveBeenCalled();
});

it.each(['running', 'no_candidate_unknown', 'technical_failure', 'candidate_needs_validation'] as const)(
  'does not expose a checkpoint for outcome %s', async (outcome) => {
    vi.mocked(observeRostJob).mockResolvedValue({ ...observation, outcome });
    expect(await readRostConflictStatus(deps, run)).toMatchObject({ status: 'no_current_conflict' });
    expect(readCheckpoint).not.toHaveBeenCalled();
  },
);

it('does not mistake a lost observation for infeasibility', async () => {
  vi.mocked(observeRostJob).mockRejectedValueOnce(new RostJobObservationError());
  expect(await readRostConflictStatus(deps, run)).toMatchObject({ status: 'observation_unavailable', solveStarted: false });
  expect(readCheckpoint).not.toHaveBeenCalled();
});

it('refuses cross-thread observations and tampered records', async () => {
  vi.mocked(observeRostJob).mockResolvedValueOnce({ ...observation, threadId: 'other' });
  await expect(readRostConflictStatus(deps, run)).rejects.toThrow('identity');
  readCheckpoint.mockResolvedValue({ ...scope, kind: 'rost_conflict_loop', payload: {}, digest: 'invalid' });
  await expect(readRostConflictStatus(deps, run)).rejects.toThrow('checkpoint');
});

it('does not inspect private watches for members or delegated bots', async () => {
  role = 'member';
  expect(await readRostConflictStatus(deps, run)).toMatchObject({ status: 'no_current_conflict' });
  role = 'admin';
  expect(await readRostConflictStatus(deps, { ...run, trigger: 'bot_message' })).toMatchObject({ status: 'no_current_conflict' });
  expect(findWatch).not.toHaveBeenCalled();
});
