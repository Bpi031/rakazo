import { useEffect, useState } from "react";
import { Check, FileText } from "lucide-react";
import { priorityApi } from "../pages/RulePrioritiesPanel";
import type { Review } from "../pages/RulePrioritiesPanel";

export function PolicyReviewCard({ botId, reviewId }: { botId: string; reviewId: string }) {
  const [review, setReview] = useState<Review | null>(null); const [error, setError] = useState("");
  const [password, setPassword] = useState(""); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true; setReview(null); setError(""); setPassword(""); setConfirmed(false);
    void priorityApi<Review>("review/" + encodeURIComponent(reviewId)).then((value) => {
      if (value.botId !== botId || value.id !== reviewId) throw new Error("Review belongs to another bot");
      if (live) setReview(value);
    }).catch(() => { if (live) setError("This draft review is unavailable. Ask your agent to refresh it."); });
    return () => { live = false; };
  }, [botId, reviewId]);
  async function apply() {
    if (!review || !password || !confirmed || busy) return;
    setBusy(true); setError("");
    try {
      const value = await priorityApi<Review>("apply", { id: review.id, digest: review.digest, password, phrase: "CREATE DRAFT " + review.id });
      if (value.id !== reviewId || value.botId !== botId) throw new Error("Review identity changed");
      setReview(value);
    } catch { setError("Draft creation was not confirmed. Refresh the exact review before retrying."); }
    finally { setPassword(""); setBusy(false); }
  }
  return <section aria-label="Policy draft review" className="w-full min-w-0 max-w-3xl space-y-3 rounded-lg border border-border p-4">
    <h3 className="flex items-center gap-2 text-base font-semibold"><FileText size={16} />{review?.applied ? "Draft created" : "Review proposed preferences"}</h3>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!review && !error && <p role="status">Loading review...</p>}
    {review && <><ul className="space-y-2 text-sm">{review.review.changes.map((change) => {
      const before = review.review.beforeRules.find((r) => r.id === change.id);
      return <li key={change.id} className="break-words"><p>{before?.summary ?? change.id}</p>
        <p className="text-xs text-muted-foreground">Weight {before?.weight} to {change.weight} · Tier {before?.priority} to {change.priority}</p></li>;
    })}</ul>
    <details><summary className="cursor-pointer text-sm">Policy and controlled-language changes</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{review.review.sourceDiff}</pre>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{review.review.beforeCnl}</pre>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{review.review.afterCnl}</pre>
      <p className="mt-2 break-all text-xs">Review digest: {review.digest}</p>
    </details>
    {review.applied ? <p role="status" className="break-all text-sm">{review.applied.policyPath}. No solve started; no policy approval granted.</p> : <>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />Create a separate draft. Keep hard rules and active solves unchanged.</label>
      <label className="block text-sm">Current password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} className="mt-1 block w-full rounded border border-border bg-background p-2" /></label>
      <button type="button" disabled={busy || !confirmed || !password || Date.parse(review.expiresAt) <= Date.now()} onClick={() => void apply()} className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm disabled:opacity-40"><Check size={16} />Create reviewed draft</button>
    </>}</>}
  </section>;
}
