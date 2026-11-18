import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb } from '@rakazo/db';
import { PolicyWorkflow } from './policy-workflow.js';

const url = process.env.ROST_USAGE_SMOKE_DATABASE_URL;
describe.skipIf(!url)('Policy receipts with isolated PostgreSQL', () => {
  it('persists an immutable decision, rejects drift, and claims diagnosis once', async () => {
    const address = new URL(url!);
    expect(address.hostname).toBe('127.0.0.1');
    expect(address.pathname).toBe('/rost_usage_smoke');
    const { prisma, pool } = createDb(url!);
    const id = 'policy-smoke-' + randomUUID();
    const actor = { userId:id, spaceId:id, email:'synthetic@example.invalid', isDeploymentOwner:false };
    let calls = 0;
    const snapshot = { baseline:{sourceSha256:'b'.repeat(64)}, candidate:{sourceSha256:'a'.repeat(64)}, inputs:[] as string[] };
    // Only identity lookup and numerical transport are synthetic; JSON persistence,
    // audit writes, transactions and compare-and-set use real PostgreSQL.
    const db = {
      agentWorkbenchRecord:prisma.agentWorkbenchRecord, teamAudit:prisma.teamAudit,
      $transaction:prisma.$transaction.bind(prisma),
      spaceMember:{findUnique:async()=>({organizationId:id,member:{role:'admin'}})},
      teamMemberControl:{findUnique:async()=>null},
      bot:{findFirstOrThrow:async()=>({computerId:id,computer:{id,kind:'docker',scope:'dedicated',state:'running',providerRef:id,homeKey:id}})},
      run:{findUniqueOrThrow:async()=>({status:'running',trigger:'user',userId:id,spaceId:id,botId:id})},
    };
    const sandbox = {async *execute(_computer:unknown, request:any) {
      calls++;
      const input = JSON.parse(Buffer.from(request.argv.at(-2),'base64').toString());
      yield {type:'stdout',data:JSON.stringify(input.operation==='diagnose'?{status:'indeterminate',solveStarted:false}:snapshot)};
      yield {type:'exit',code:0};
    }};
    const service = new PolicyWorkflow({prisma:db as any,sandbox:sandbox as any});
    try {
      await prisma.organization.create({data:{id,name:id,slug:id,createdAt:new Date()}});
      const review = await service.agent(id,'review',{operation:'review',baseline:'workspace/old.rost',baselineWorkingDirectory:'workspace',
        policy:'workspace/new.rost',workingDirectory:'workspace',purpose:'new_policy',reason:'Synthetic policy review'});
      const captured = await service.get(actor,review.id!);
      const approved = await service.decide(actor,captured.id,captured.digest,'approve');
      expect(approved).toMatchObject({policyApprovalGranted:true,contractApprovalGranted:false,computeAllowanceGranted:false,solveStarted:false});
      await service.decide(actor,captured.id,captured.digest,'approve');
      expect(await prisma.teamAudit.count({where:{organizationId:id}})).toBe(1);
      expect((await prisma.agentWorkbenchRecord.findUniqueOrThrow({where:{id:captured.id}})).expiresAt).toBeNull();
      expect(await service.agent(id,'current',{operation:'current',policy:'workspace/new.rost',workingDirectory:'workspace'}))
        .toMatchObject({id:captured.id,status:'approved',reusedApproval:true});
      await expect(service.get({...actor,userId:'other'},captured.id)).rejects.toThrow();
      await expect(service.decide(actor,captured.id,captured.digest,'reject')).rejects.toThrow();
      snapshot.inputs.push('changed');
      expect(await service.status(actor,captured.id)).toMatchObject({status:'stale',policyApprovalGranted:false});
      const request = {operation:'diagnose',policy:'workspace/new.rost',workingDirectory:'workspace',seconds:1};
      await service.agent(id,'diagnosis',request); const count = calls;
      await service.agent(id,'diagnosis',request); expect(calls).toBe(count);
      expect(await prisma.agentWorkbenchRecord.count({where:{runId:id}})).toBe(2);
    } finally {
      await prisma.agentWorkbenchRecord.deleteMany({where:{runId:id}});
      await prisma.teamAudit.deleteMany({where:{organizationId:id}});
      await prisma.organization.deleteMany({where:{id}});
      await prisma.$disconnect(); await pool.end();
    }
  });
});
