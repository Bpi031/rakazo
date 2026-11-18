import { useEffect, useState } from 'react';
import { Check, RefreshCw, X } from 'lucide-react';
import { rpc } from '../lib/rpc';

type Review = { id: string; botId: string; digest: string; status: string; expiresAt: string | null; approvalMode?: 'manager_chat' | 'owner_review';
  review: { reason: string; purpose: string; snapshot: { sourceDiff: string; cnlDiff: string; candidate: { policy: string; cnl: string; inputs?: { path: string; sha256: string }[]; dependencies?: { path: string; sha256: string }[] } } } };
async function api(path: string, body?: unknown) {
  const response = await fetch('/api/policy-workflow/' + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('Review unavailable or changed');
  return response.json();
}
export function PolicyOwnerCard({ botId, reviewId }: { botId: string; reviewId: string }) {
  const [review, setReview] = useState<Review | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [continued, setContinued] = useState(false);
  async function refresh() {
    const value = await api('review/' + reviewId);
    if (value.botId !== botId || value.id !== reviewId) throw new Error('Review ownership changed');
    setReview(value);
  }
  useEffect(() => { let live = true; setReview(null); setConfirmed(false); setContinued(false); setError('');
    void api('review/' + reviewId).then(v => { if (v.id !== reviewId || v.botId !== botId) throw new Error('Review ownership changed'); if (live) setReview(v); })
      .catch(() => { if (live) setError('Review unavailable. Refresh or check the existing review.'); }); return () => { live = false; };
  }, [botId, reviewId]);
  async function continueInChat() {
    await rpc.threads.followUp({ botId, clientNonce: 'policy-approval:' + reviewId,
      text: `The manager approved policy review ${reviewId}. Check policy_workflow status against the current files. Continue the existing request using only its separately authorized unused allowance; if none exists, ask. Check job ownership and never duplicate a job. This approval does not resolve other conflicts, permit unapproved rule changes, or grant additional runtime.` });
    setContinued(true);
  }
  async function decide(decision: 'approve' | 'reject') {
    if (!review || busy || !confirmed) return;
    setBusy(true); setError('');
    try {
      const result = await api('decide', { id: reviewId, digest: review.digest, decision, confirmed: true });
      const status = decision === 'approve' ? 'approved' : 'rejected';
      if (result.id !== reviewId || result.digest !== review.digest || result.status !== status) {
        throw new Error('Decision changed');
      }
      setReview({ ...review, status });
      if (decision === 'approve') {
        try { await continueInChat(); }
        catch { setError('Approval recorded. Continuation not confirmed; check chat or use Continue in chat.'); }
      }
    }
    catch { setError('Decision not confirmed. Refresh and check the exact revision, expiry and your manager account.'); }
    finally { setBusy(false); }
  }
  if (review?.approvalMode === 'manager_chat' || !review && !error) return null;
  const details = review && <><p className="whitespace-pre-wrap break-words text-sm">{review.review.reason}</p>
    <details><summary>Source changes</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{review.review.snapshot.sourceDiff || 'No source difference'}</pre></details>
    <details><summary>Controlled-language changes</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{review.review.snapshot.cnlDiff || 'No controlled-language difference'}</pre></details>
    <details><summary>Full candidate policy review</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{review.review.snapshot.candidate.cnl}</pre><p className="break-all text-xs">Digest: {review.digest}</p></details>
    <details><summary>Captured input files</summary><ul className="max-h-60 overflow-auto text-xs">{[...(review.review.snapshot.candidate.inputs ?? []), ...(review.review.snapshot.candidate.dependencies ?? [])].map((pin, index) => <li key={index} className="py-1 break-all">{pin.path}<br />SHA-256: {pin.sha256}</li>)}</ul></details>
  </>;
  if (review?.status === 'approved') return <section aria-label="Recorded policy change" className="w-full min-w-0 max-w-3xl space-y-2 text-sm">
    <details className="space-y-3"><summary className="cursor-pointer"><Check className="mr-2 inline-block" size={16} />Policy change recorded</summary>
      {details}<p>Feasibility and workbook validation are separate.</p>
    </details>
    {error && <><p role="alert" className="text-destructive">{error}</p><button disabled={busy || continued} className="rounded border border-border px-3 py-2 disabled:opacity-40" onClick={async () => {
      setBusy(true); try { await continueInChat(); setError(''); }
      catch { setError('Continuation not confirmed. Check chat before retrying.'); } finally { setBusy(false); }
    }}>Continue in chat</button></>}
  </section>;
  return <section aria-label="Manager policy approval" className="w-full min-w-0 max-w-3xl space-y-3 rounded-lg border border-border p-4">
    <div className="flex items-center justify-between gap-2"><h3 className="text-base font-semibold">{review?.review.purpose === 'person_amendment' ? 'Review person-specific policy change' : review?.review.purpose === 'bounded_exception' ? 'Review bounded rule exception' : 'Review policy correction'}</h3>
      <button title="Refresh approval" aria-label="Refresh approval" disabled={busy} onClick={() => void refresh().catch(() => setError('Review unavailable.'))}><RefreshCw size={16} /></button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!review && !error && <p role="status">Loading review...</p>}
    {review && <>{details}
      <p className="text-sm">Status: {review.status}. Feasibility and workbook validation are separate.</p>
      {review.status === 'pending' && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />I reviewed this exact revision and its inputs. This decision grants no additional run time.</label>
        <div className="flex flex-wrap gap-3"><button className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 disabled:opacity-40" disabled={busy || !confirmed || !review.expiresAt || Date.parse(review.expiresAt) <= Date.now()} onClick={() => void decide('approve')}><Check size={16} />Approve and continue</button>
          <button className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 disabled:opacity-40" disabled={busy || !confirmed} onClick={() => void decide('reject')}><X size={16} />Reject</button></div></>}
    </>}
  </section>;
}
