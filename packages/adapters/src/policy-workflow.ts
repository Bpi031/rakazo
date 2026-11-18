import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '@rakazo/contracts';
import type { PrismaClient, Prisma } from '@rakazo/db';
import type { SandboxProvider } from '@rakazo/adapter-kit';
import { memberScope } from './team-storage.js';
import { managerRole, teamDigest } from './team-policy.js';
import { toComputerRef } from './computer-support.js';
import { readRostConflictStatus } from './rost-conflict-status.js';

const relative = z.string().max(1024).refine(v => v.startsWith('workspace/') && !/[\\\x00-\x1f]/.test(v) && v.split('/').every(p => p && p !== '.' && p !== '..'), 'Use an exact workspace-relative path');
const cwd = z.union([z.literal('workspace'), relative]);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200);
const amendment = z.discriminatedUnion('action', [
  z.object({ action: z.literal('exclude'), ruleId: name, personId: name }).strict(),
  z.object({ action: z.literal('quota'), ruleId: name, personId: name, value: z.number().int().min(0).max(1_000_000) }).strict(),
]);
export const policyWorkflowInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('conflict_status') }).strict(),
  z.object({ operation: z.literal('review'), baseline: relative, baselineWorkingDirectory: cwd,
    policy: relative, workingDirectory: cwd, reason: z.string().trim().min(1).max(2000),
    purpose: z.enum(['new_policy', 'model_correction']), diagnosisId: hex.optional() }).strict(),
  z.object({ operation: z.literal('status'), id: hex }).strict(),
  z.object({ operation: z.literal('current'), policy: relative, workingDirectory: cwd }).strict(),
  z.object({ operation: z.literal('amendment_review'), baseline: relative, baselineWorkingDirectory: cwd,
    policy: relative, workingDirectory: cwd, reason: z.string().trim().min(1).max(2000),
    changes: z.array(amendment).min(1).max(20), diagnosisId: hex.optional() }).strict(),
  z.object({ operation: z.literal('diagnose'), policy: relative, workingDirectory: cwd,
    seconds: z.number().int().min(1).max(300) }).strict(),
  z.object({ operation: z.literal('relaxation_review'), flowId: hex, policy: relative, workingDirectory: cwd,
    proposal: relative, seconds: z.number().int().min(1).max(300), reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ operation: z.literal('apply'), id: hex }).strict(),
]);
export const policyOwnerDecision = z.object({ id: hex, digest: hex, decision: z.enum(['approve', 'reject']),
  confirmed: z.literal(true) }).strict();
const helper = readFileSync(new URL('./policy-workflow.py', import.meta.url), 'utf8');
const library = readFileSync(new URL('./policy-priority-helper.py', import.meta.url), 'utf8');
const helperDigest = teamDigest({ helper, library });
const relaxationHelper = readFileSync(new URL('./policy-relaxation.py', import.meta.url), 'utf8');
const relaxationDigest = teamDigest({ helper: relaxationHelper, library });
const amendmentHelper = readFileSync(new URL('./policy-amendment.py', import.meta.url), 'utf8');
const amendmentDigest = teamDigest({ helper: amendmentHelper, sourceReview: helper, library });
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type Data = Record<string, any>;
export const managerChatPolicy = () => process.env.ROST_POLICY_REVIEW_MODE === 'manager_chat';
export function policyWorkflowInstruction() {
  const mode = managerChatPolicy() ? 'Deployment policy mode: manager_chat. The signed-in manager directs native Rost modelling and finite debug runs in chat. Do not create approval cards, require a password, or stop because policyApprovalGranted=false. That flag is not the run permission. Follow the confirmed business instructions, check and compare CNL, inspect owned jobs, then use one bounded background Rost job and a token-free watch. Ask only for genuinely missing business facts or a new relaxation choice, not repeated approval of a recorded choice. Source review tools provide checked evidence, not independent policy-owner approval. Never invent approval receipts, bypass an existing formal contract/relaxation ledger, silently weaken rules, duplicate a solve or renew an allowance. Validate and read back both saved workbooks before delivery. This deployment mode supersedes older case/skill instructions requiring a separate approval card for ordinary native source revisions.' : '';
  return mode;
}

export class PolicyWorkflow {
  constructor(private deps: { prisma: PrismaClient; sandbox: SandboxProvider }) {}
  private async owned(actor: Actor, botId: string) {
    const scope = await memberScope(this.deps.prisma, actor.userId, actor.spaceId);
    if (!managerRole(scope.role)) throw new Error('Policy-owner manager role required');
    const bot = await this.deps.prisma.bot.findFirstOrThrow({ where: { id: botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null }, include: { computer: true } });
    if (bot.computer?.scope !== 'dedicated' || bot.computer.state !== 'running' || !bot.computer.providerRef)
      throw new Error('An existing private manager computer is required');
    return { bot, scope };
  }
  private async execute(actor: Actor, botId: string, input: Data) {
    const { bot } = await this.owned(actor, botId);
    const timeout = input.operation === 'capture_amendment' ? 240_000
      : ['diagnose', 'capture_relaxation'].includes(input.operation) ? (input.seconds + 240) * 1000 : 100_000;
    const codeSource = input.operation === 'capture_amendment' ? amendmentHelper : input.operation.endsWith('_relaxation') ? relaxationHelper : helper;
    let stdout = ''; let code: number | undefined;
    for await (const event of this.deps.sandbox.execute(toComputerRef(bot.computer!), {
      argv: ['/opt/office-python/bin/python3', '-I', '-c', codeSource, Buffer.from(JSON.stringify(input)).toString('base64'), Buffer.from(library).toString('base64'),
        ...(input.operation === 'capture_amendment' ? [Buffer.from(helper).toString('base64')] : [])],
      cwd: '/home/rakazo', timeoutMs: timeout, unsetEnv: ['PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD'],
    }, { userId: actor.userId, spaceId: actor.spaceId, botId, operationId: 'policy-workflow:' + randomUUID(), traceId: 'policy-workflow', signal: AbortSignal.timeout(timeout + 5000) })) {
      if (event.type === 'stdout') { stdout += event.data; if (Buffer.byteLength(stdout) > 4 * 1024**2) throw new Error('Policy review output cap'); }
      if (event.type === 'exit') code = event.code;
    }
    const value = JSON.parse(stdout);
    if (code !== 0 || value.error) throw new Error(value.error || 'Policy workflow failed');
    return { value, computerId: bot.computerId };
  }
  private async load(actor: Actor, id: string) {
    hex.parse(id);
    const row = await this.deps.prisma.agentWorkbenchRecord.findFirstOrThrow({ where: { id, userId: actor.userId, spaceId: actor.spaceId, kind: 'policy_owner_review' } });
    await this.owned(actor, row.botId);
    const payload = row.payload as Data;
    if (row.digest !== teamDigest(payload.review) || payload.review.helperDigest !== (payload.review.kind === 'relaxation' ? relaxationDigest : payload.review.kind === 'amendment' ? amendmentDigest : helperDigest)) throw new Error('Review identity/version changed');
    return { row, payload };
  }
  async get(actor: Actor, id: string) {
    const { row, payload } = await this.load(actor, id);
    return { id, botId: row.botId, digest: row.digest, status: row.status, expiresAt: row.expiresAt,
      approvalMode: managerChatPolicy() ? 'manager_chat' : 'owner_review',
      review: payload.review, receipt: payload.receipt ?? null, solveStarted: false };
  }
  async status(actor: Actor, id: string) {
    const { row, payload } = await this.load(actor, id);
    const now = Date.now();
    let status = row.expiresAt && row.expiresAt.getTime() <= now ? 'expired' : row.status;
    if (status === 'checked' && !managerChatPolicy()) status = 'review_required';
    if (status === 'approved' || status === 'pending' || status === 'checked') {
      const fresh = await this.execute(actor, row.botId, payload.review.kind === 'relaxation'
        ? { ...payload.review.capture, operation: 'check_relaxation', snapshot: payload.review.snapshot } : payload.review.capture);
      if (fresh.computerId !== payload.review.computerId || teamDigest(fresh.value) !== teamDigest(payload.review.snapshot)) status = 'stale';
    }
    return { id, digest: row.digest, status, policy: payload.review.capture.policy,
      workingDirectory: payload.review.capture.workingDirectory, sourceSha256: payload.review.snapshot.candidate.sourceSha256,
      policyApprovalGranted: status === 'approved', approvalScope: payload.review.kind === 'relaxation' ? 'exact_native_relaxation' : 'exact_native_source_revision',
      contractApprovalGranted: false, relaxationAuthorityGranted: status === 'approved' && payload.review.kind === 'relaxation', computeAllowanceGranted: false,
      receipt: status === 'approved' ? payload.receipt : null, solveStarted: false,
      separateApprovalRequired: !managerChatPolicy() || payload.review.kind === 'relaxation',
      backgroundSupported: (status === 'approved' || status === 'checked') && payload.review.kind !== 'relaxation',
      action: status === 'checked' ? 'Exact source/input evidence checked. No separate approval card in manager-chat mode. Follow the manager request and unused finite allowance; check ownership, use a fresh background job, then validate and read back both workbooks. This is not independent policy approval.' : status === 'approved' ? payload.review.kind === 'relaxation'
        ? 'Exact native relaxation approved. Use policy_workflow apply with this ID; never manufacture a decision JSON. No added runtime or roster delivery authority.'
        : 'Exact source/input revision approved. Recheck this receipt before use; preserve any separately confirmed policy contract. Use only a separately authorized, unused numerical allowance. Never reuse this receipt for altered bytes or a relaxation ledger.' : 'Use the authenticated manager review card; do not ask for repeated chat consent or invent approval.' };
  }
  /** Browser-only authenticated boundary. Never offered as a model tool. */
  async decide(actor: Actor, id: string, digest: string, decision: 'approve' | 'reject') {
    if (managerChatPolicy()) throw new Error('Separate approval cards are disabled for this manager-chat deployment');
    const initial = await this.load(actor, id);
    if (initial.row.digest !== digest) throw new Error('Review digest changed');
    const live = await this.status(actor, id);
    if (live.status !== 'pending' && live.status !== (decision === 'approve' ? 'approved' : 'rejected')) throw new Error('Review expired, stale or already decided');
    if (live.status !== 'pending') return live;
    await this.deps.prisma.$transaction(async tx => {
      const { scope } = await this.owned(actor, initial.row.botId);
      const receipt = { schema: 'rakazo/policy-owner-receipt/v1', id: randomUUID(), reviewId: id, reviewDigest: digest,
        subject: actor.userId, author: initial.payload.review.author, decidedAt: new Date().toISOString(), decision,
        scope: initial.payload.review.kind === 'relaxation' ? 'exact_native_relaxation' : 'exact_native_source_revision', contractApprovalGranted: false,
        relaxationAuthorityGranted: initial.payload.review.kind === 'relaxation', computeAllowanceGranted: false };
      const changed = await tx.agentWorkbenchRecord.updateMany({ where: { id, userId: actor.userId, spaceId: actor.spaceId, status: 'pending', digest, expiresAt: { gt: new Date() } },
        data: { status: decision === 'approve' ? 'approved' : 'rejected', payload: json({ ...initial.payload, receipt }),
          ...(decision === 'approve' && initial.payload.review.kind !== 'relaxation' ? { expiresAt: null } : {}) } });
      if (changed.count !== 1) throw new Error('Review changed; refresh');
      await tx.teamAudit.create({ data: { organizationId: scope.organizationId, actorUserId: actor.userId, operation: 'policy_owner_' + decision, targetId: id, outcome: 'recorded' } });
    });
    return this.status(actor, id);
  }
  async current(actor: Actor, botId: string, policy: string, workingDirectory: string) {
    await this.owned(actor, botId);
    if (managerChatPolicy()) return { status: 'not_required', approvalMode: 'manager_chat', separateApprovalRequired: false,
      policyApprovalGranted: false, computeAllowanceGranted: false, solveStarted: false,
      action: 'No separate policy approval is required for a manager-directed native run. Follow the recorded business request and finite allowance; run live readiness/check/CNL and ownership checks, then one bounded background job. This lookup is not a source check, feasibility proof or independent approval.' };
    const rows = await this.deps.prisma.agentWorkbenchRecord.findMany({ where: {
      userId: actor.userId, spaceId: actor.spaceId, botId, kind: 'policy_owner_review',
      status: 'approved',
      payload: { path: ['review', 'capture', 'policy'], equals: policy },
    }, orderBy: { createdAt: 'desc' }, take: 1 });
    for (const row of rows) {
      const value = row.payload as Data;
      if (value.review?.kind === 'relaxation' || value.review?.capture?.workingDirectory !== workingDirectory) continue;
      try {
        const status = await this.status(actor, row.id);
        if (status.status === 'approved') return { ...status, reusedApproval: true };
        return { ...status, action: 'The recorded approval does not match current revision/inputs or has expired. Inspect the exact difference; do not request repeated consent for an unchanged run.' };
      } catch {
        return { status: 'verification_unavailable', id: row.id, policyApprovalGranted: false, solveStarted: false,
          action: 'The existing approval could not be verified. Inspect runtime/path/ownership evidence; another approval will not fix a technical verification failure. No solve or retry occurred.' };
      }
    }
    return { status: 'review_required', policyApprovalGranted: false, solveStarted: false,
      action: 'No current exact source/input approval found. Review a new or changed revision once; a run request alone is not a policy change.' };
  }
  async agent(runId: string, effectKey: string, raw: unknown) {
    const parsed = policyWorkflowInput.safeParse(raw);
    if (!parsed.success) return { error: 'Invalid policy workflow arguments', fields: parsed.error.issues.map(i => i.path.join('.')),
      action: 'Review needs baseline/candidate paths, both working directories, purpose and reason. Diagnose needs an explicit 1-300 second allowance. Status needs the review ID; conflict_status is read-only and takes no other fields. Follow the deployment approval mode; invalid arguments do not authorize a retry or another solve.' };
    const input = parsed.data;
    const run = await this.deps.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'running') throw new Error('Live owned turn required');
    const actor = { userId: run.userId, spaceId: run.spaceId, email: '', isDeploymentOwner: false };
    await this.owned(actor, run.botId);
    if (input.operation === 'conflict_status') return readRostConflictStatus(this.deps, run);
    if (input.operation === 'status') return this.status(actor, input.id);
    if (input.operation === 'current') return this.current(actor, run.botId, input.policy, input.workingDirectory);
    if (!['user', 'follow_up'].includes(run.trigger)) throw new Error('Diagnosis/review requires a direct user request, not a timer');
    if (input.operation === 'apply') {
      const { row, payload } = await this.load(actor, input.id);
      if (row.botId !== run.botId) throw new Error('Exact owned policy required');
      if (payload.review.kind !== 'relaxation') {
        const live = await this.status(actor, input.id);
        const checked = managerChatPolicy() && live.status === 'checked' && payload.review.managerRequest;
        if (!checked && (live.status !== 'approved' || payload.receipt?.decision !== 'approve')) throw new Error('Manager decision required');
        // Source revisions are already separate drafts. Adoption never overwrites a baseline or active job.
        return { ...live, adopted: true, backgroundSupported: true,
          action: 'Use this exact checked .rost revision with its working directory for rost job start --background in a fresh output directory. Use only the manager-authorized unused allowance; register its token-free completion watch. Never copy or strip an existing relaxation ledger.' };
      }
      const applyId = teamDigest({ reviewId: row.id, kind: 'protected_apply' });
      const existing = await this.deps.prisma.agentWorkbenchRecord.findUnique({ where: { id: applyId } });
      if (existing) return { id: input.id, status: existing.status, action: 'Application already claimed; inspect its ledger and receipt. Never retry after an uncertain result.' };
      const live = await this.status(actor, input.id);
      if (live.status !== 'approved' || !payload.receipt || payload.receipt.decision !== 'approve') throw new Error('Manager decision required');
      await this.deps.prisma.agentWorkbenchRecord.create({ data: { id: applyId, userId: actor.userId, spaceId: actor.spaceId,
        botId: run.botId, runId, kind: 'policy_relaxation_apply', status: 'applying', digest: row.digest, payload: json({ reviewId: row.id }) } });
      try {
        const result = await this.execute(actor, run.botId, { ...payload.review.capture, operation: 'apply_relaxation',
          snapshot: payload.review.snapshot, receipt: payload.receipt });
        await this.deps.prisma.agentWorkbenchRecord.updateMany({ where: { id: applyId, status: 'applying' }, data: { status: 'applied', payload: json(result.value) } });
        await this.deps.prisma.agentWorkbenchRecord.updateMany({ where: { id: row.id, status: 'approved' }, data: { status: 'applied' } });
        return { id: row.id, ...result.value, deadlineUtc: payload.review.deadlineUtc, computeAllowanceGranted: false };
      } catch {
        await this.deps.prisma.agentWorkbenchRecord.updateMany({ where: { id: applyId, status: 'applying' }, data: { status: 'needs_attention' } });
        return { id: row.id, status: 'needs_attention', action: 'Exact apply not confirmed. Inspect the ledger; no automatic retry or solve.' };
      }
    }
    const id = teamDigest({ runId, effectKey, kind: 'policy-workflow' });
    if (input.operation === 'amendment_review') {
      const capture = { operation: 'capture_amendment', baseline: input.baseline,
        baselineWorkingDirectory: input.baselineWorkingDirectory, policy: input.policy,
        workingDirectory: input.workingDirectory, changes: input.changes };
      const { value: snapshot, computerId } = await this.execute(actor, run.botId, capture);
      if (input.diagnosisId) {
        const diagnosis = await this.deps.prisma.agentWorkbenchRecord.findFirstOrThrow({ where: { id: input.diagnosisId,
          userId: actor.userId, spaceId: actor.spaceId, botId: run.botId, kind: 'policy_diagnosis', status: 'completed' } });
        const evidence = diagnosis.payload as Data;
        if (diagnosis.digest !== teamDigest(evidence) || evidence.status !== 'infeasible'
            || teamDigest(evidence.snapshot) !== teamDigest(snapshot.baseline)) throw new Error('Amendment baseline must match the exact server-held diagnosis');
      } else if (!managerChatPolicy()) {
        const baseline = await this.current(actor, run.botId, input.baseline, input.baselineWorkingDirectory);
        if (baseline.status !== 'approved' || !('id' in baseline) || !baseline.id) throw new Error('Use the approved baseline or its exact server-held diagnosis; do not fabricate a baseline');
        const approved = await this.load(actor, baseline.id);
        if (teamDigest(approved.payload.review.snapshot.candidate) !== teamDigest(snapshot.baseline))
          throw new Error('Amendment baseline differs from the approved source/input revision');
      }
      return this.sourceReview(actor, { ...run, id: runId }, id, capture, snapshot, computerId, input.reason,
        'person_amendment', { kind: 'amendment', helperDigest: amendmentDigest, diagnosisId: input.diagnosisId ?? null });
    }
    if (input.operation === 'relaxation_review') {
      if (managerChatPolicy()) return { status: 'source_revision_required', policyApprovalGranted: false, solveStarted: false,
        action: 'This deployment uses manager-directed source revisions, not approval cards. Keep a baseline and prepare only the explicitly selected source change; check/CNL it before a bounded run. Existing formal contracts and relaxation ledgers are not bypassed or stripped.' };
      const flow = await this.deps.prisma.agentWorkbenchRecord.findFirstOrThrow({ where: { id: input.flowId,
        userId: actor.userId, spaceId: actor.spaceId, botId: run.botId, kind: 'rost_conflict_loop' } });
      const value = flow.payload as Data;
      if (flow.digest !== teamDigest(value) || value.diagnosis?.status !== 'infeasible'
          || input.policy !== value.diagnosis.policy || input.workingDirectory !== value.diagnosis.workingDirectory
          || Date.now() / 1000 + input.seconds + 240 >= value.deadlineUtc) throw new Error('Current diagnosed policy and unused review allowance required');
      const claimId = teamDigest({ flowId: input.flowId, proposal: input.proposal, kind: 'relaxation_review' });
      if (await this.deps.prisma.agentWorkbenchRecord.findUnique({ where: { id: claimId } }))
        return { status: 'already_attempted', action: 'Inspect existing review evidence; never automatically repeat numerical review.' };
      const claim = await this.deps.prisma.agentWorkbenchRecord.updateMany({ where: { id: flow.id, digest: flow.digest,
        status: { in: ['needs_choice', 'waiting_decision'] } }, data: { status: 'reviewing' } });
      if (claim.count !== 1) throw new Error('This conflict already has a review reservation; inspect it before further work');
      await this.deps.prisma.agentWorkbenchRecord.create({ data: { id: claimId, userId: actor.userId, spaceId: actor.spaceId,
        botId: run.botId, runId, kind: 'policy_review_reservation', status: 'running', digest: teamDigest(input), payload: json(input) } });
      const capture = { operation: 'capture_relaxation', policy: input.policy, workingDirectory: input.workingDirectory,
        proposal: input.proposal, seconds: input.seconds, diagnosisSha256: value.diagnosis.evidenceSha256, deadlineUtc: value.deadlineUtc };
      try {
        const { value: snapshot, computerId } = await this.execute(actor, run.botId, capture);
        const review = { kind: 'relaxation', capture, snapshot, computerId, helperDigest: relaxationDigest,
          reason: input.reason, purpose: 'bounded_exception', author: 'agent:' + run.botId + ':' + runId,
          diagnosisId: value.diagnosisId, deadlineUtc: value.deadlineUtc, createdAt: new Date().toISOString() };
        await this.deps.prisma.agentWorkbenchRecord.create({ data: { id, userId: actor.userId, spaceId: actor.spaceId,
          botId: run.botId, runId, kind: 'policy_owner_review', status: 'pending', digest: teamDigest(review), payload: json({ review }),
          expiresAt: new Date(Math.min(Date.parse(snapshot.expiresAt), Date.now() + 86400_000)) } });
        await this.deps.prisma.agentWorkbenchRecord.updateMany({ where: { id: claimId, status: 'running' }, data: { status: 'completed' } });
        return { id, status: 'pending', action: 'Exact bounded exception review posted. Wait for the signed-in manager; no password re-entry or solve.' };
      } catch {
        await this.deps.prisma.agentWorkbenchRecord.updateMany({ where: { id: claimId, status: 'running' }, data: { status: 'failed' } });
        return { status: 'needs_attention', action: 'Native bounded review was not approval-ready or unsupported. Inspect evidence. Do not request approval for an unproved repair or edit rules instead.' };
      }
    }
    if (input.operation === 'diagnose') {
      // Claim before invoking native work. A lost response is not permission to rerun.
      const existing = await this.deps.prisma.agentWorkbenchRecord.findUnique({ where: { id } });
      if (existing) {
        if (existing.userId !== run.userId || existing.spaceId !== run.spaceId || existing.botId !== run.botId
            || existing.kind !== 'policy_diagnosis' || existing.digest !== teamDigest(existing.payload))
          throw new Error('Diagnosis checkpoint identity changed');
        const { snapshot: _snapshot, ...summary } = existing.payload as Data;
        return { ...summary, id, status: existing.status, diagnosisStatus: summary.status,
          action: 'Diagnosis already attempted. Read its saved evidence; no automatic retry.' };
      }
      await this.deps.prisma.agentWorkbenchRecord.create({ data: { id, userId: actor.userId, spaceId: actor.spaceId, botId: run.botId,
        runId, kind: 'policy_diagnosis', status: 'running', digest: teamDigest(input), payload: json({ request: input }) } });
      let value: Data;
      try { value = (await this.execute(actor, run.botId, { ...input, id })).value; }
      catch {
        await this.deps.prisma.agentWorkbenchRecord.updateMany({ where: { id, status: 'running' }, data: { status: 'failed' } });
        return { id, status: 'failed', action: 'Inspect the owned diagnosis evidence. Failure is not infeasibility; no automatic retry.' };
      }
      await this.deps.prisma.agentWorkbenchRecord.updateMany({ where: { id, status: 'running' }, data: { status: 'completed', payload: json(value), digest: teamDigest(value) } });
      const { snapshot: _snapshot, ...summary } = value;
      return { ...summary, id,
        action: value.status === 'infeasible'
          ? 'Read the saved conflict evidence. It grants no policy or compute authority and does not prove a minimum-cost repair.'
          : 'Inspect bounded diagnosis evidence. Unknown/failure is not infeasibility and does not authorize a rule change or automatic retry.' };
    }
    const existing = await this.deps.prisma.agentWorkbenchRecord.findUnique({ where: { id } });
    if (existing) return { ...await this.status(actor, id), reusedReview: true };
    const capture = { operation: 'capture', baseline: input.baseline, baselineWorkingDirectory: input.baselineWorkingDirectory,
      policy: input.policy, workingDirectory: input.workingDirectory };
    const { value: snapshot, computerId } = await this.execute(actor, run.botId, capture);
    if (input.purpose === 'model_correction' && (!managerChatPolicy() || input.diagnosisId)) {
      if (!input.diagnosisId) throw new Error('A current bounded Rost diagnosis is required for an infeasibility correction');
      const diagnosis = await this.deps.prisma.agentWorkbenchRecord.findFirstOrThrow({ where: { id: input.diagnosisId,
        userId: actor.userId, spaceId: actor.spaceId, botId: run.botId, kind: 'policy_diagnosis', status: 'completed' } });
      const evidence = diagnosis.payload as Data;
      if (diagnosis.digest !== teamDigest(evidence) || evidence.status !== 'infeasible' ||
          teamDigest(evidence.snapshot) !== teamDigest(snapshot.baseline)) throw new Error('Diagnosis is not current proved-infeasible baseline evidence');
    }
    return this.sourceReview(actor, { ...run, id: runId }, id, capture, snapshot, computerId, input.reason, input.purpose,
      { helperDigest, diagnosisId: input.diagnosisId ?? null });
  }
  private async sourceReview(actor: Actor, run: Data, id: string, capture: Data, snapshot: Data,
    computerId: string | null, reason: string, purpose: string, extra: Data) {
    const chat = managerChatPolicy();
    let managerRequest: Data | undefined;
    if (chat) {
      if (!run.sourceMessageId || !run.threadId) throw new Error('A direct signed-in manager message is required for a source revision');
      const message = await this.deps.prisma.message.findFirstOrThrow({ where: {
        id: run.sourceMessageId, threadId: run.threadId, role: 'user',
        thread: { userId: actor.userId, spaceId: actor.spaceId, botId: run.botId },
      }, select: { id: true } });
      managerRequest = { subject: actor.userId, messageId: message.id, runId: run.id, mode: 'manager_chat' };
    }
    const existing = await this.deps.prisma.agentWorkbenchRecord.findMany({ where: { userId: actor.userId,
      spaceId: actor.spaceId, botId: run.botId, kind: 'policy_owner_review', status: { in: chat ? ['checked'] : ['approved', 'pending'] },
      payload: { path: ['review', 'capture', 'policy'], equals: capture.policy } }, orderBy: { createdAt: 'desc' }, take: 100 });
    for (const row of existing) {
      const prior = (row.payload as Data).review;
      if (row.digest !== teamDigest(prior) || prior.helperDigest !== extra.helperDigest || prior.computerId !== computerId
          || prior.purpose !== purpose || teamDigest(prior.capture) !== teamDigest(capture)
          || teamDigest(prior.snapshot) !== teamDigest(snapshot)) continue;
      const live = await this.status(actor, row.id);
      if ((chat ? ['checked'] : ['approved', 'pending']).includes(live.status)) return { ...live, reusedApproval: live.status === 'approved', reusedReview: true };
    }
    const review = { capture, snapshot, computerId, reason, purpose, ...extra,
      ...(managerRequest ? {managerRequest} : {}), author: 'agent:' + run.botId + ':' + run.id, createdAt: new Date().toISOString() };
    await this.deps.prisma.agentWorkbenchRecord.create({ data: { id, userId: actor.userId, spaceId: actor.spaceId, botId: run.botId,
      runId: run.id, kind: 'policy_owner_review', status: chat ? 'checked' : 'pending', digest: teamDigest(review), payload: json({ review }), expiresAt: chat ? null : new Date(Date.now() + 86400_000) } });
    if (chat) return this.status(actor, id);
    return { id, status: 'pending', policyApprovalGranted: false, solveStarted: false,
      action: 'Authenticated policy-owner review card posted in chat. Wait quietly for the manager. Do not use rule_priorities as an approval check. This grants no numerical allowance or formal relaxation authority.' };
  }
}

export const policyWorkflowTools = [{ name: 'policy_workflow', description: 'Exact source evidence and bounded diagnosis. conflict_status reads the owned result and any legacy checkpoint without numerical work. Follow the host deployment mode. In manager_chat mode there is NO separate approval card: current returns not_required; source review/amendment_review returns checked evidence tied to the direct manager message; apply adopts it. policyApprovalGranted=false is not a run blocker in that mode, and no independent approval is claimed. In owner_review mode only, use current/status to reuse approval or obtain one card for a changed policy, never per run. For a manager-selected person-specific change, keep the baseline and draft a separate .rost: wrap the original hard-rule outer person iteration body in if p != PERSON:. For a quota override add if p == PERSON: with the original single count comparison and only its integer bound changed. Submit amendment_review with baseline/candidate, working directories, reason and changes[{ruleId,personId,action:exclude|quota,value?}]. The compiler rejects other semantic changes. Use unified rost job start --background with the unused authorized finite allowance, new output and token-free completion watch. Existing formal contracts and relaxation ledgers are not bypassed; ledger background jobs remain unsupported. No operation starts a solve, renews compute or delivers workbooks. Expert/composed models require their separate route. ',
  inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['review', 'status', 'current', 'conflict_status', 'diagnose', 'amendment_review', 'relaxation_review', 'apply'] },
    baseline: { type: 'string' }, baselineWorkingDirectory: { type: 'string' }, policy: { type: 'string' }, workingDirectory: { type: 'string' },
    reason: { type: 'string', maxLength: 2000 }, purpose: { type: 'string', enum: ['new_policy', 'model_correction'] },
    changes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
      ruleId: { type: 'string' }, personId: { type: 'string' }, action: { type: 'string', enum: ['exclude', 'quota'] },
      value: { type: 'integer', minimum: 0, maximum: 1000000 } }, required: ['ruleId', 'personId', 'action'], additionalProperties: false } },
    id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, flowId: { type: 'string' }, proposal: { type: 'string' }, diagnosisId: { type: 'string', description: 'Completed server-held diagnosis of the exact baseline, checked whenever supplied. In owner_review mode it is required for model_correction; amendments require this or an approved baseline. Manager-chat source preparation does not require an approval card.' },
    seconds: { type: 'integer', minimum: 1, maximum: 300 } }, required: ['operation'], additionalProperties: false } }];
