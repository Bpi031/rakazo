import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb } from '../../db/src/client.ts';
import { recordUsage } from '../../db/src/usage.ts';
import { CodexProtocolRuntime } from './codex-protocol.mjs';
import { validateCodexQuestion } from './codex-question-validation.ts';

const url = process.env.ROST_USAGE_SMOKE_DATABASE_URL;
describe.skipIf(!url)('Codex question usage with real PostgreSQL', () => {
  it.each(['dynamic', 'native'])('persists %s question usage before presentation, idempotently', async (kind) => {
    const address = new URL(url);
    // This opt-in test must never write to the deployment database.
    expect(address.hostname).toBe('127.0.0.1');
    expect(address.pathname).toBe('/rost_usage_smoke');
    const { prisma, pool } = createDb(url);
    const id = `usage-smoke-${randomUUID()}`;
    try {
      await prisma.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
      await prisma.space.create({ data: { id, name: id, organizationId: id } });
      const queue = [], finished = [], recorded = [];
      let closed = false;
      const session = {
        close: async () => { closed = true; },
        send: async (m) => {
          if (!m.method) return;
          let result = {};
          if (m.method === 'model/list') result = { data: [{ id: 'fixture-model', inputModalities: ['text'] }] };
          if (m.method === 'skills/list') result = { data: [{ skills: [] }] };
          if (m.method === 'configRequirements/read') result = { requirements: null };
          if (m.method === 'thread/start') result = { thread: { id } };
          if (m.method === 'turn/start') result = { turn: { id: 'turn' } };
          queue.push({ id: m.id, result });
          if (m.method === 'turn/start') {
            queue.push({ method: 'thread/tokenUsage/updated', params: { threadId: id, turnId: 'turn', tokenUsage: {
              total: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 230 },
            } } });
            queue.push(kind === 'dynamic'
              ? { id: 100, method: 'item/tool/call', params: { threadId: id, turnId: 'turn', callId: 'choice', tool: 'rakazo__ask_user', arguments: { question: 'Choose a synthetic option', options: ['A', 'B'] } } }
              : { id: 100, method: 'item/tool/requestUserInput', params: { threadId: id, turnId: 'turn', questions: [{ id: 'choice', header: 'Choice', question: 'Choose a synthetic option', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] } });
          }
        },
        messages: { async *[Symbol.asyncIterator]() { for (let n = 0; n < 100 && queue.length; n++) yield queue.shift(); } },
      };
      const attribution = { spaceId: id, userId: id, botId: id, runId: id };
      const request = {
        runId: id, botId: id, threadId: id, model: { id: 'fixture-model' }, history: [], prompt: 'Offline question', instructions: '',
        tools: [{ name: 'ask_user', description: 'Ask', inputSchema: { type: 'object' } }],
        executeTool: async () => { throw new Error('No external effects permitted'); },
        openRuntimeSession: async () => session,
        nativeControl: {
          mode: 'execute', prepare: async () => ({ mode: 'execute', action: 'none', previous: null, persistent: true, sessionKey: 'a'.repeat(64) }),
          observe: async () => {}, finish: async (v) => finished.push(v),
        },
        onUsage: async (event) => { expect(closed).toBe(true); await recordUsage(prisma, event, attribution); recorded.push(event); },
      };
      const events = [];
      for await (const event of new CodexProtocolRuntime({ models: ['fixture-model'], key: 'x'.repeat(64), validateQuestion: validateCodexQuestion }).run(request, { spaceId: id, userId: id, botId: id, runId: id })) {
        if (event.type === 'ask') expect(await prisma.usageRecord.count({ where: { spaceId: id } })).toBe(1);
        events.push(event);
      }
      expect(events.filter(e => e.type === 'ask')).toHaveLength(1);
      expect(recorded).toHaveLength(1);
      await recordUsage(prisma, recorded[0], attribution);
      const rows = await prisma.usageRecord.findMany({ where: { spaceId: id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ provider: 'codex-foundry', model: 'fixture-model', inputTokens: 150, cacheReadTokens: 50, outputTokens: 30, reasoningTokens: 5, totalTokens: 230, runId: null, parentRunId: id });
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ completed: false, paused: true });
    } finally {
      await prisma.organization.deleteMany({ where: { id } });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
