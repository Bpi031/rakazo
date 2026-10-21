import { expect, it, vi } from 'vitest';
import { NativeControl } from './native-control.js';

function fixture() {
  let generation = 0;
  let row: any = null;
  let threadId = 'private-thread';
  const actor = { userId: 'owner', spaceId: 'space' };
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    thread: { findFirstOrThrow: vi.fn(async () => ({ historyCompactionGeneration: generation })) },
    run: { findUniqueOrThrow: vi.fn(async () => ({ status: 'completed' })) },
    agentWorkbenchRecord: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async ({ create, update }: any) => { row = row ? { ...row, ...update } : create; return row; }),
    },
  };
  const service = new NativeControl({ $transaction: async (fn: any) => fn(tx) } as any);
  vi.spyOn(service, 'actor').mockImplementation(async () => ({ actor, run: { id: 'next', botId: 'bot', threadId, leaseFence: 1 } }) as any);
  vi.spyOn(service, 'view').mockResolvedValue({ preferences: { mode: 'execute', persistence: true, action: 'none', revision: 0 } } as any);
  return {
    service, tx,
    complete() { row = { ...row, status: 'completed', payload: { fingerprint: row.payload.fingerprint, threadId: 'native-owned', turnId: 'turn' } }; },
    clear() { generation++; },
    changeThread() { threadId = 'different-private-thread'; },
  };
}

it('resumes unchanged owned history but not a cleared chat generation', async () => {
  const f = fixture();
  expect((await f.service.prepare('first', 'tools-v1')).previous).toBeNull();
  f.complete();
  expect((await f.service.prepare('second', 'tools-v1')).previous?.threadId).toBe('native-owned');
  f.complete(); f.clear();
  expect((await f.service.prepare('after-clear', 'tools-v1')).previous).toBeNull();
  expect(f.tx.thread.findFirstOrThrow).toHaveBeenLastCalledWith({ where: { id: 'private-thread', spaceId: 'space', botId: 'bot' }, select: { historyCompactionGeneration: true } });
});

it('does not borrow a completed native session from another product thread', async () => {
  const f = fixture();
  await f.service.prepare('first', 'tools-v1'); f.complete(); f.changeThread();
  expect((await f.service.prepare('different-thread', 'tools-v1')).previous).toBeNull();
});
