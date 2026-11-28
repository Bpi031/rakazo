import { useEffect, useState } from "react";
import { Check, FileText } from "lucide-react";
import { priorityApi } from "../pages/RulePrioritiesPanel";
import type { Review } from "../pages/RulePrioritiesPanel";
import { useBoundSpaceId } from "../lib/query/space-rpc";
import { useManagedOperation } from "../lib/query/use-managed-operation";

export function PolicyReviewCard({ botId, reviewId }: { botId: string; reviewId: string }) {
  const [review, setReview] = useState<Review | null>(null); const [error, setError] = useState("");
  const [password, setPassword] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const write = useManagedOperation();
  const busy = write.pending;
  const spaceId = useBoundSpaceId();
  useEffect(() => {
    let live = true; setReview(null); setError(""); setPassword(""); setConfirmed(false);
    void priorityApi<Review>("review/" + encodeURIComponent(reviewId), undefined, spaceId).then((value) => {
      if (value.botId !== botId || value.id !== reviewId) throw new Error("Review belongs to another bot");
      if (live) setReview(value);
    }).catch(() => { if (live) setError("This draft review is unavailable. Ask your agent to refresh it."); });
    return () => { live = false; };
  }, [botId, reviewId, spaceId]);
  function apply() {
    if (!review || !password || !confirmed || busy) return;
    write.run(async (scope) => {
      setError("");
      setPassword("");
      try {
        const value = await priorityApi<Review>("apply", { id: review.id, digest: review.digest, password, phrase: "CREATE DRAFT " + review.id }, scope.spaceId);
        if (value.id !== reviewId || value.botId !== botId) throw new Error("Review identity changed");
        if (scope.isCurrent()) setReview(value);
      } catch {
        if (scope.isCurrent()) setError("Draft creation was not confirmed. Refresh the exact review before retrying.");
      }
    });
  }
  return <section aria-label="Policy draft review" className="w-full min-w-0 max-w-3xl space-y-3 rounded-lg border border-border p-4">
    <h3 className="flex items-center gap-2 text-body-lg font-semibold"><FileText size={16} />{review?.applied ? "Draft created" : "Review proposed preferences"}</h3>
    {error && <p role="alert" className="text-body text-destructive">{error}</p>}
    {!review && !error && <p role="status">Loading review...</p>}
    {review && <><ul className="space-y-2 text-body">{review.review.changes.map((change) => {
      const before = review.review.beforeRules.find((r) => r.id === change.id);
      return <li key={change.id} className="break-words"><p>{before?.summary ?? change.id}</p>
        <p className="flex flex-wrap gap-x-3 text-label text-muted-foreground">
          <span>Weight {before?.weight} to {change.weight}</span>
          <span>Tier {before?.priority} to {change.priority}</span>
        </p></li>;
    })}</ul>
    <details><summary className="cursor-pointer text-body">Policy and controlled-language changes</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-label">{review.review.sourceDiff}</pre>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-label">{review.review.beforeCnl}</pre>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-label">{review.review.afterCnl}</pre>
      <p className="mt-2 break-all text-label">Review digest: {review.digest}</p>
    </details>
    {review.applied ? <p role="status" className="break-all text-body">{review.applied.policyPath}. No solve started; no policy approval granted.</p> : <>
      <label className="flex items-start gap-2 text-body"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />Create a separate draft. Keep hard rules and active solves unchanged.</label>
      <label className="block text-body">Current password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} className="mt-1 block w-full rounded border border-border bg-background p-2" /></label>
      <button type="button" disabled={busy || !confirmed || !password || Date.parse(review.expiresAt) <= Date.now()} onClick={() => void apply()} className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-body disabled:opacity-40"><Check size={16} />Create reviewed draft</button>
    </>}</>}
  </section>;
}
