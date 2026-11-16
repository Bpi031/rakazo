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
  vi.spyOn(service, 'actor').mockImplementation(async () => ({ actor, bot: { computer: { scope: 'dedicated' } }, run: { id: 'next', botId: 'bot', threadId, leaseFence: 1 } }) as any);
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
  expect(f.tx.thread.findFirstOrThrow).toHaveBeenLastCalledWith({ where: { id: 'private-thread', spaceId: 'space', botId: 'bot' }, select: { historyCompactionGeneration: true,
      activeBranchId: true,
      checkpointGeneration: true,
      checkpointBlocked: true } });
});

it('does not borrow a completed native session from another product thread', async () => {
  const f = fixture();
  await f.service.prepare('first', 'tools-v1'); f.complete(); f.changeThread();
  expect((await f.service.prepare('different-thread', 'tools-v1')).previous).toBeNull();
});

it("reconstructs after rollback even when a stale fork preference remains", async () => {
  const f = fixture();
  await f.service.prepare('first', 'tools-v1');
  f.complete();
  f.tx.thread.findFirstOrThrow.mockResolvedValue({
    historyCompactionGeneration: 1,
    checkpointGeneration: 1,
    activeBranchId: "restored",
    checkpointBlocked: false,
  } as any);
  vi.mocked(f.service.view).mockResolvedValue({
    preferences: { mode: "execute", persistence: true, action: "fork", revision: 1 },
  } as any);
  const next = await f.service.prepare("restored", "tools-v1");
  expect(next.previous).toBeNull();
  expect(next.action).toBe("none");
});

it("keeps native session identities separate for two bots on the same Computer", async () => {
  const rows = new Map<string, any>();
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    thread: { findFirstOrThrow: vi.fn(async () => ({ historyCompactionGeneration: 0, checkpointGeneration: 0, checkpointBlocked: false })) },
    run: { findUniqueOrThrow: vi.fn(async () => ({ status: "completed" })) },
    agentWorkbenchRecord: {
      findUnique: vi.fn(async ({ where }) => rows.get(where.id) ?? null),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = rows.has(where.id) ? { ...rows.get(where.id), ...update } : create;
        rows.set(where.id, row); return row;
      }),
    },
  };
  const service = new NativeControl({ $transaction: async (operation: any) => operation(tx) } as any);
  vi.spyOn(service, "actor").mockImplementation(async (runId) => {
    const botId = runId.startsWith("a-") ? "bot-a" : "bot-b";
    return { actor: { userId: "owner", spaceId: "space" }, bot: { computer: { scope: 'team' } }, run: { id: runId, botId, threadId: `thread:${botId}`, computerId: "shared-computer", leaseFence: 1, checkpointGeneration: 0 } } as any;
  });
  vi.spyOn(service, "view").mockResolvedValue({ preferences: { persistence: true, mode: "execute", action: "none", revision: 0 } } as any);
  const first = await service.prepare("a-first", "same-tools");
  const row = rows.get(first.sessionKey);
  rows.set(first.sessionKey, { ...row, status: "completed", payload: { fingerprint: first.fingerprint, threadId: "native-a", turnId: "turn-a" } });
  const other = await service.prepare("b-first", "same-tools");
  expect(first.workspace).toEqual({ cwd: '/home/rakazo/bots/bot-a', roots: ['/home/rakazo/bots/bot-a', '/home/rakazo/shared'] });
  expect(other.workspace.roots).not.toContain('/home/rakazo/bots/bot-a');
  expect(other.sessionKey).not.toBe(first.sessionKey);
  expect(other.previous).toBeNull();
  expect((await service.prepare("a-next", "same-tools")).previous?.threadId).toBe("native-a");
});
