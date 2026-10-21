import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CompletionReceipt, NativeDecision } from "@rakazo/contracts";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient, Prisma } from "@rakazo/db";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { memberScope } from "./team-storage.js";
import { toComputerRef } from "./computer-support.js";
import { teamDigest } from "./team-policy.js";

const files = readFileSync(new URL('./native-files.py', import.meta.url), 'utf8');
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export const nativeEnabled = () => process.env.ROST_AGENT_NATIVE === '1';
export class NativeControl {
  constructor(private db: PrismaClient, private sandbox?: SandboxProvider) {}
  private async owned(actor: Actor, botId: string) {
    await memberScope(this.db, actor.userId, actor.spaceId);
    const bot = await this.db.bot.findFirstOrThrow({ where: { id: botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null }, include: { computer: true } });
    if (bot.computer?.scope === 'team') throw new Error('Private native workspace required');
    return bot;
  }
  private where(actor: Actor, botId: string) { return { userId: actor.userId, spaceId: actor.spaceId, botId }; }
  private key(actor: Actor, botId: string, kind: string) { return teamDigest({ ...this.where(actor, botId), kind }); }
  async view(actor: Actor, botId: string) {
    await this.owned(actor, botId);
    const records = await this.db.agentWorkbenchRecord.findMany({ where: { ...this.where(actor, botId), kind: { startsWith: 'native_' } }, orderBy: { updatedAt: 'desc' }, take: 80 });
    const preferences = await this.db.agentWorkbenchRecord.findUnique({ where: { id: this.key(actor, botId, 'native_preferences') } });
    await this.owned(actor, botId);
    return { enabled: nativeEnabled(), preferences: preferences?.payload ?? { mode: 'execute', persistence: true, action: 'none', revision: 0 }, records: records.filter(r => r.kind !== 'native_preferences').map(r => ({ id: r.id, kind: r.kind, status: r.status, payload: r.payload, updatedAt: r.updatedAt.toISOString() })), policyApprovalGranted: false, solveStarted: false };
  }
  async decide(actor: Actor, raw: unknown) {
    const input = NativeDecision.parse(raw); await this.owned(actor, input.botId);
    if (!nativeEnabled()) throw new Error('Native capability disabled');
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${this.key(actor, input.botId, 'native_preferences')}, 0))`;
      const id = this.key(actor, input.botId, 'native_preferences');
      const old = await tx.agentWorkbenchRecord.findUnique({ where: { id } });
      if (((old?.payload as any)?.revision ?? 0) !== input.revision) throw new Error('Preferences changed; refresh');
      const payload = { ...input.preferences, ...(input.preferences.action === 'fork' || input.preferences.action === 'review' ? { mode: 'plan' } : {}), revision: input.revision + 1 };
      return tx.agentWorkbenchRecord.upsert({ where: { id }, create: { id, ...this.where(actor,input.botId), kind: 'native_preferences', status: 'selected', payload: json(payload), digest: teamDigest(payload) }, update: { payload: json(payload), digest: teamDigest(payload) } });
    });
  }
  async actor(runId: string) {
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'running') throw new Error('Live owned agent turn required');
    const actor = { userId: run.userId, spaceId: run.spaceId, email: '', isDeploymentOwner: false };
    await this.owned(actor, run.botId); return { actor, run };
  }
  async observe(runId: string, kind: string, payload: unknown) {
    const { actor, run } = await this.actor(runId);
    if (!['capabilities','watch','diff','files','review','completion'].includes(kind) || Buffer.byteLength(JSON.stringify(payload)) > 200000) throw new Error('Native observation cap');
    const id = teamDigest({ runId, kind });
    return this.db.agentWorkbenchRecord.upsert({ where: { id }, create: { id, ...this.where(actor,run.botId), runId, kind: 'native_' + kind, status: 'observed', digest: teamDigest(payload), payload: json(payload) }, update: { digest: teamDigest(payload), payload: json(payload) } });
  }
  async prepare(runId: string, fingerprint: string) {
    const { actor, run } = await this.actor(runId);
    const view = await this.view(actor, run.botId); const p = view.preferences as any;
    const id = this.key(actor, run.botId, 'native_session');
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
      const thread = await tx.thread.findFirstOrThrow({ where: { id: run.threadId, spaceId: actor.spaceId, botId: run.botId }, select: { historyCompactionGeneration: true } });
      // Clearing chat increments its generation; native history must not resurrect it.
      const ownedFingerprint = teamDigest({ fingerprint, threadId: run.threadId, historyGeneration: thread.historyCompactionGeneration });
      const row = await tx.agentWorkbenchRecord.findUnique({ where: { id } });
      const priorRun=row?.runId?await tx.run.findUniqueOrThrow({where:{id:row.runId}}):null;
      const answeredPause=row?.runId===runId&&row.status==='needs_review'&&(row.payload as any)?.paused===true&&run.leaseFence>((row.payload as any)?.leaseFence??Number.MAX_SAFE_INTEGER);
      if (priorRun&&['queued','leased','running','waiting_input','waiting_takeover'].includes(priorRun.status)&&!answeredPause) throw new Error('Native session already owned');
      const previous = row?.status === 'completed' && priorRun?.status==='completed' && (row.payload as any)?.fingerprint === ownedFingerprint ? (row.payload as any) : null;
      const action = p.action ?? 'none';
      if (['compact','fork'].includes(action) && (!previous || !p.persistence)) throw new Error('A completed matching persistent native session is required');
      const payload = { fingerprint: ownedFingerprint, previous, mode: p.mode, action, sessionKey: id, revision: p.revision, currentRunId: runId,leaseFence:run.leaseFence };
      await tx.agentWorkbenchRecord.upsert({ where: { id }, create: { id, ...this.where(actor,run.botId), runId, kind: 'native_session', status: 'running', digest: teamDigest(payload), payload: json(payload) }, update: { runId, status:'running', digest:teamDigest(payload), payload:json(payload) } });
      const prefId = this.key(actor, run.botId, 'native_preferences');
      if (action !== 'none') await tx.agentWorkbenchRecord.updateMany({ where: { id: prefId, digest: teamDigest(p) }, data: { payload: json({ ...p, action:'none', revision:p.revision+1 }), digest:teamDigest({ ...p, action:'none', revision:p.revision+1 }) } });
      return { ...payload, previous: p.persistence && action !== 'review' ? previous : null, persistent: p.persistence === true };
    });
  }
  async finish(runId: string, value: any) {
    const run = await this.db.run.findUniqueOrThrow({where:{id:runId}});
    const actor = {userId:run.userId,spaceId:run.spaceId,email:'',isDeploymentOwner:false};
    await this.owned(actor,run.botId);
    const id=this.key(actor,run.botId,'native_session');
    const row=await this.db.agentWorkbenchRecord.findUniqueOrThrow({where:{id}});
    if(row.runId!==runId||row.status!=='running') throw new Error('Native completion ownership changed');
    const conversationOnly=(row.payload as any).action==='fork';
    const completed=value.completed===true&&!conversationOnly&&run.status==='running'&&typeof value.threadId==='string'&&typeof value.turnId==='string';
    const payload={fingerprint:(row.payload as any).fingerprint,threadId:value.threadId??null,turnId:value.turnId??null,usage:value.usage??null,completed,conversationOnly,paused:value.paused===true,leaseFence:(row.payload as any).leaseFence};
    const changed=await this.db.agentWorkbenchRecord.updateMany({where:{id,runId,status:'running'},data:{status:completed?'completed':'needs_review',payload:json(payload),digest:teamDigest(payload)}});
    if(changed.count!==1)throw new Error('Native completion ownership changed');
  }
  async files(actor: Actor, botId: string, input: Record<string,unknown>) {
    const bot=await this.owned(actor,botId);
    if(!this.sandbox||!bot.computer?.providerRef||bot.computer.state!=='running')throw new Error('Existing private computer required');
    let stdout='',code:number|undefined;
    for await(const e of this.sandbox.execute(toComputerRef(bot.computer),{argv:['/opt/office-python/bin/python3','-I','-c',files,Buffer.from(JSON.stringify(input)).toString('base64')],cwd:'/home/rakazo',timeoutMs:15000,unsetEnv:['PYTHONPATH','PYTHONHOME','LD_PRELOAD']},{...this.where(actor,botId),operationId:randomUUID(),traceId:'native-observation',signal:AbortSignal.timeout(20000)})){
      if(e.type==='stdout'){stdout+=e.data;if(Buffer.byteLength(stdout)>400000)throw new Error('Observation cap');}if(e.type==='exit')code=e.code;
    }
    const result=JSON.parse(stdout);if(code!==0||result.error)throw new Error('Private workspace observation rejected');await this.owned(actor,botId);return result;
  }
  async tool(runId: string, name: string, args: any) {
    const {actor,run}=await this.actor(runId);
    if(name==='workspace_list'&&Object.keys(args).length===0)return this.files(actor,run.botId,{operation:'inventory'});
    if(name==='workspace_read'&&Object.keys(args).join(',')==='path'&&typeof args.path==='string')return this.files(actor,run.botId,{operation:'read',path:args.path});
    throw new Error('Read-only native tool denied');
  }
  async receipt(runId: string, raw: unknown) {
    const claim=CompletionReceipt.parse(raw);const {actor,run}=await this.actor(runId);
    const all=[...claim.deliverables,...claim.evidence];
    const paths=[...new Set(all.map(f=>f.path))];
    let observed:any[]=[];let status='needs_review';
    try{observed=(await this.files(actor,run.botId,{operation:'receipt',paths})).files;
      if(all.every(f=>observed.some(o=>o.path===f.path&&o.sha256===f.sha256)))status=claim.kind==='answer'&&claim.deliverables.length===0?'answer_recorded':'files_verified';
    }catch{}
    const artifacts=await this.db.artifact.findMany({where:{...this.where(actor,run.botId),createdAt:{gte:run.createdAt}},select:{id:true,hash:true,name:true}});
    const payload={claim,observed,artifacts,status,validationAssessment:'model_supplied_unverified',policyApprovalGranted:false,solveStarted:false};
    await this.observe(runId,'completion',payload);
    return {message:status==='needs_review'?'Completion requires review: requested files were missing or changed. No completion was certified.':claim.message,status};
  }
}
