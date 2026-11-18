import type { Hono } from 'hono';
import type { Actor } from '@rakazo/contracts';
import { PolicyWorkflow, policyOwnerDecision } from '@rakazo/adapters';
import { isAllowedWebOrigin } from './web-origins.js';

export function mountPolicyWorkflow(app: Hono, deps: {
  service: Pick<PolicyWorkflow, 'get' | 'decide'>;
  actor: (request: Request) => Promise<Actor | null>;
  webOrigin: string; additionalWebOrigins?: readonly string[];
}) {
  const attempts = new Map<string, { at: number; count: number }>();
  app.all('/api/policy-workflow/*', async c => {
    c.header('cache-control', 'no-store');
    const actor = await deps.actor(c.req.raw);
    if (!actor) return c.json({ error: 'Sign in required' }, 401);
    try {
      const route = new URL(c.req.url).pathname.slice('/api/policy-workflow/'.length);
      if (c.req.method === 'GET' && route.startsWith('review/')) return c.json(await deps.service.get(actor, route.slice(7)));
      if (route !== 'decide' || c.req.method !== 'POST') return c.json({ error: 'Not found' }, 404);
      if (!isAllowedWebOrigin(c.req.header('origin'), deps) || c.req.header('authorization') || !c.req.header('cookie') ||
          !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'Same-origin browser session required' }, 403);
      const now = Date.now();
      for (const [key, value] of attempts) if (now - value.at > 60_000) attempts.delete(key);
      const old = attempts.get(actor.userId);
      if ((old?.count ?? 0) >= 5 || !old && attempts.size >= 1000) return c.json({ error: 'Confirmation rate limit reached' }, 429);
      attempts.set(actor.userId, { at: old?.at ?? now, count: (old?.count ?? 0) + 1 });
      const reader = c.req.raw.body?.getReader(); if (!reader) return c.json({ error: 'JSON required' }, 400);
      let size = 0; const chunks: Uint8Array[] = [];
      try { while (true) { const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 4096) { await reader.cancel(); return c.json({ error: 'Decision too large' }, 413); } chunks.push(part.value);
      } } finally { reader.releaseLock(); }
      const input = policyOwnerDecision.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return c.json(await deps.service.decide(actor, input.id, input.digest, input.decision));
    } catch {
      return c.json({ error: 'Policy decision not confirmed. Refresh the review; check manager ownership, source/input changes and expiry. No solve started.' }, 409);
    }
  });
}
