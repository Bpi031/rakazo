import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '@rakazo/db';
import { NativeControl, NativeSessionBusyError } from './native-control.js';
import { teamDigest } from './team-policy.js';

const url = process.env.ROST_USAGE_SMOKE_DATABASE_URL;
describe.skipIf(!url)('Native session contention with isolated PostgreSQL', () => {
  it('serializes concurrent reservations and lets the waiting run resume only after completion', async () => {
    const address = new URL(url!);
    expect(address.hostname).toBe('127.0.0.1'); expect(address.pathname).toBe('/rost_usage_smoke');
    const { prisma, pool } = createDb(url!);
    const id = 'native-smoke-' + randomUUID();
    const actor = { userId:id, spaceId:id };
    const states = new Map([[id+'-user','running'], [id+'-routine','running']]);
    // Identity/run lookups are synthetic. Reservations and advisory locks use
    // real independent transactions, so concurrent callers cannot both win.
    const service = new NativeControl({$transaction: (fn:any) => prisma.$transaction(tx => fn({
      $executeRaw: tx.$executeRaw.bind(tx), agentWorkbenchRecord: tx.agentWorkbenchRecord,
      thread:{findFirstOrThrow:async()=>({historyCompactionGeneration:0})},
      run:{findUniqueOrThrow:async({where}:any)=>({status:states.get(where.id)})},
    }))} as any);
    vi.spyOn(service,'actor').mockImplementation(async runId => ({actor,run:{id:runId,botId:id,threadId:id,leaseFence:1}}) as any);
    vi.spyOn(service,'view').mockResolvedValue({preferences:{mode:'execute',persistence:true,action:'none',revision:0}} as any);
    try {
      const runs = [...states.keys()];
      const outcomes = await Promise.allSettled(runs.map(run => service.prepare(run,'same-runtime')));
      expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
      const loser = outcomes.findIndex(x=>x.status==='rejected');
      expect((outcomes[loser] as PromiseRejectedResult).reason).toBeInstanceOf(NativeSessionBusyError);
      const row = await prisma.agentWorkbenchRecord.findFirstOrThrow({where:{botId:id,kind:'native_session'}});
      expect(row.runId).toBe(runs[1-loser]); expect(row.status).toBe('running');
      states.set(row.runId!,'completed');
      const payload = {...row.payload as object,threadId:'native-thread',turnId:'native-turn',completed:true};
      await prisma.agentWorkbenchRecord.update({where:{id:row.id},data:{status:'completed',payload,digest:teamDigest(payload)}});
      expect((await service.prepare(runs[loser]!, 'same-runtime')).previous?.threadId).toBe('native-thread');
      expect((await prisma.agentWorkbenchRecord.findUniqueOrThrow({where:{id:row.id}})).runId).toBe(runs[loser]);
    } finally {
      await prisma.agentWorkbenchRecord.deleteMany({where:{botId:id}});
      vi.restoreAllMocks(); await prisma.$disconnect(); await pool.end();
    }
  });
});
