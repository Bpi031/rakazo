import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FileText, FolderOpen, LockKeyhole, RefreshCw } from "lucide-react";
import type { Bot } from "@rakazo/contracts";
import { rpc, withSpaceHeaders } from "../lib/rpc";

type Rule = { id: string; summary?: string; groupId?: string; tier: "hard" | "soft"; weight: string | null; priority: string; sourceLine: number; locked: boolean };
type BusinessGroup = { id: string; label: string; description: string; ruleIds: string[] };
type Change = { id: string; weight: string; priority: string };
type Catalog = { policy: string; workingDirectory: string; sourceSha256: string; inputs?: unknown[]; rules: Rule[]; groups?: BusinessGroup[];
  presentationStatus?: string; cnl: string; tiers: string[]; maxWeight: string };
export type Review = { id: string; botId: string; digest: string; expiresAt: string; review: { policy: string; changes: Change[];
  beforeRules: Rule[]; beforeCnl: string; afterCnl: string; sourceDiff: string }; applied: {
    policyPath: string; cnlPath: string; manifestPath: string; policyApprovalGranted: false; solveStarted: false } | null };

export async function priorityApi<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch("/api/rule-priorities/" + route, { method: body === undefined ? "GET" : "POST", credentials: "include",
    headers: withSpaceHeaders({ "content-type": "application/json" }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Rule Priorities is unavailable. Please try again.");
  const value = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? "Please sign in again." :
    response.status === 403 ? "Browser confirmation and current password are required." :
    "Rule review rejected. Reload the policy; check changes, ownership, expiry and supported policy form.");
  return value as T;
}

export function RulePrioritiesPanel({ activeBotId }: { activeBotId?: string } = {}) {
  const reviewId = new URLSearchParams(window.location.search).get("priorityReview");
  const [bots, setBots] = useState<Bot[]>([]); const [botId, setBotId] = useState("");
  const [policy, setPolicy] = useState(""); const [cwd, setCwd] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [changes, setChanges] = useState<Record<string, Change>>({}); const [review, setReview] = useState<Review | null>(null);
  const [filter, setFilter] = useState("all"); const [query, setQuery] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [password, setPassword] = useState(""); const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    let live = true;
    void rpc.bots.list().then(async (rows) => {
      if (!live) return; setBots(rows);
      if (reviewId) {
        const value = await priorityApi<Review>("review/" + encodeURIComponent(reviewId));
        if (activeBotId && value.botId !== activeBotId) throw new Error("Review belongs to another bot");
        if (live) { setBotId(value.botId); setReview(value); setPolicy(value.review.policy); }
      } else if (activeBotId || rows[0]) setBotId(activeBotId ?? rows[0]!.id);
    }).catch(() => { if (live) setError("Rule Priorities could not be loaded."); });
    return () => { live = false; };
  }, [reviewId, activeBotId]);
  useEffect(() => {
    if (!botId || reviewId) return;
    let live = true; setBusy(true); setCatalog(null); setReview(null); setChanges({}); setGroupId(null); setError(""); setNotice(""); setPolicy(""); setCwd("");
    void priorityApi<Catalog & { status: string }>("current?botId=" + encodeURIComponent(botId)).then((value) => {
      if (!live) return;
      if (value.status === "not_registered") { setNotice("No policy registered by this bot yet."); return; }
      setCatalog(value); setPolicy(value.policy); setCwd(value.workingDirectory);
    }).catch((error: Error) => { if (live) setError(error.message); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [botId, reviewId]);
  async function load() {
    setBusy(true); setError(""); setNotice(""); setReview(null); setPassword(""); setConfirmed(false);
    try {
      const value = await priorityApi<Catalog>("inspect", { botId, policy, workingDirectory: cwd });
      setCatalog(value); setChanges({}); setGroupId(null);
    } catch (error) { setCatalog(null); setError((error as Error).message); }
    finally { setBusy(false); }
  }
  function edit(rule: Rule, field: "weight" | "priority", value: string) {
    if (rule.locked) return;
    setReview(null); setPassword(""); setConfirmed(false);
    setChanges((old) => ({ ...old, [rule.id]: { id: rule.id, weight: rule.weight!, priority: rule.priority, ...old[rule.id], [field]: value } }));
  }
  const selected = useMemo(() => Object.values(changes).filter((value) => {
    const old = catalog?.rules.find((rule) => rule.id === value.id); return old && (old.weight !== value.weight || old.priority !== value.priority);
  }), [changes, catalog]);
  const valid = selected.length > 0 && selected.every((row) => /^[1-9][0-9]{0,15}$/.test(row.weight) && Number.isSafeInteger(Number(row.weight)) && Number(row.weight) <= Number(catalog?.maxWeight));
  useEffect(() => {
    if (!botId || reviewId || busy || review || selected.length || !catalog) return;
    let live = true; let pending = false;
    const timer = window.setInterval(() => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      void priorityApi<Catalog & { status: string }>("current?botId=" + encodeURIComponent(botId)).then((value) => {
        if (!live || value.status !== "current") return;
        if (value.sourceSha256 !== catalog.sourceSha256 || value.policy !== catalog.policy || JSON.stringify(value.inputs) !== JSON.stringify(catalog.inputs)) {
          setCatalog(value); setPolicy(value.policy); setCwd(value.workingDirectory); setChanges({});
          setNotice("Current policy refreshed from your bot.");
        }
      }).catch(() => { /* Apply independently rejects stale source/inputs. */ }).finally(() => { pending = false; });
    }, 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [botId, reviewId, busy, review, selected.length, catalog]);
  async function propose() {
    if (!catalog || !valid) return; setBusy(true); setError(""); setPassword(""); setConfirmed(false);
    try { setReview(await priorityApi<Review>("review", { botId, policy: catalog.policy, workingDirectory: catalog.workingDirectory,
      sourceSha256: catalog.sourceSha256, changes: selected })); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function apply() {
    if (!review || !confirmed || !password) return; setBusy(true); setError("");
    try { setReview(await priorityApi<Review>("apply", { id: review.id, digest: review.digest, password, phrase: "CREATE DRAFT " + review.id })); }
    catch (error) { setError((error as Error).message); } finally { setPassword(""); setBusy(false); }
  }
  const matches = (rule: Rule) => (filter === "all" || rule.tier === filter) &&
    (rule.summary ?? "").toLowerCase().concat(" ", rule.id.toLowerCase()).includes(query.toLowerCase());
  const rows = catalog?.rules.filter((rule) => (!groupId || rule.groupId === groupId) && matches(rule)) ?? [];
  const currentGroup = catalog?.groups?.find((group) => group.id === groupId);
  const grouped = Boolean(catalog?.groups?.length) && !groupId;
  return <section aria-label="Chat rule priorities" className={"space-y-5 text-sm " + (activeBotId ? "" : "p-5")}>
    {!activeBotId && <h2 className="text-base font-semibold">Rule Priorities</h2>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!activeBotId && <label className="block space-y-1"><span>Bot</span><select aria-label="Policy bot" disabled={busy || Boolean(reviewId)} value={botId}
      onChange={(event) => setBotId(event.target.value)} className="block w-full border border-border bg-background p-2">
      <option value="" disabled>Select a bot</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>}
    {!reviewId && <details><summary className="cursor-pointer">Policy Source</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="space-y-1">Source .rost<input aria-label="Policy source" value={policy} onChange={(event) => { setPolicy(event.target.value); setCatalog(null); setReview(null); }}
        placeholder="workspace/project/policy.rost" className="block w-full border border-border bg-background p-2" disabled={busy} /></label>
      <label className="space-y-1">Working directory<input aria-label="Policy working directory" value={cwd} onChange={(event) => { setCwd(event.target.value); setCatalog(null); setReview(null); }}
        placeholder="workspace/project" className="block w-full border border-border bg-background p-2" disabled={busy} /></label>
      <button type="button" disabled={busy || !botId || !policy || !cwd} onClick={() => void load()}
        className="flex items-center gap-2 justify-self-start border border-border px-3 py-2 disabled:opacity-50"><FolderOpen size={16} />Load Current Policy</button>
    </div></details>}
    {catalog && <><div className="flex flex-wrap items-center justify-between gap-3"><span className="break-all font-mono text-xs">{catalog.policy}</span>
      <button title="Refresh current policy" aria-label="Refresh current policy" type="button" disabled={busy} onClick={() => void load()} className="p-2"><RefreshCw size={16} /></button></div>
      <div className="flex flex-wrap items-center justify-between gap-3"><div role="group" aria-label="Rule type" className="inline-flex border border-border">
        {["soft", "hard", "all"].map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
          className={"px-3 py-2 " + (filter === value ? "bg-muted font-medium" : "")}>{value === "all" ? "All" : value === "hard" ? "Hard" : "Soft"}</button>)}</div>
        <input type="search" aria-label="Find rule" placeholder="Find rule" value={query} onChange={(event) => setQuery(event.target.value)} className="max-w-full border border-border bg-background p-2" /></div>
      {catalog.presentationStatus === "stale" && <p role="status">Business groups need refreshing. Showing current controlled-language rules.</p>}
      {grouped ? <div><p className="mb-3 text-xs text-muted-foreground">{catalog.groups!.length} business groups · {catalog.rules.length} executable rules</p>
        <ul className="divide-y divide-border">{catalog.groups!.filter((group) => catalog.rules.some((rule) => rule.groupId === group.id &&
          (filter === "all" || rule.tier === filter) && (matches(rule) || (group.label + " " + group.description).toLowerCase().includes(query.toLowerCase())))).map((group) =>
          <li key={group.id}><button type="button" title={group.description} onClick={() => { setGroupId(group.id); setQuery(""); }} className="flex w-full items-start gap-3 py-3 text-left">
            <span className="min-w-0 flex-1"><span className="block break-words font-medium">{group.label}</span>
              <span className="mt-2 block text-xs">{catalog.rules.filter((rule) => rule.groupId === group.id && rule.locked).length} hard · {catalog.rules.filter((rule) => rule.groupId === group.id && !rule.locked).length} soft</span></span><ArrowRight size={16} className="mt-1 shrink-0" /></button></li>)}</ul></div> : <>
      {currentGroup && <div className="space-y-2"><button type="button" onClick={() => setGroupId(null)} className="flex items-center gap-2 text-xs"><ArrowLeft size={16} />All Business Groups</button>
        <h3 className="break-words font-medium">{currentGroup.label}</h3><p className="break-words text-xs text-muted-foreground">{currentGroup.description}</p></div>}
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="py-2 pr-3">Rule</th><th className="pr-3">Type</th><th className="pr-3">Weight</th><th>Priority</th></tr></thead>
        <tbody>{rows.map((rule) => <tr key={rule.id} className="border-t border-border"><td className="max-w-[330px] break-words py-3 pr-3"><p className="min-w-[140px] whitespace-normal">{rule.summary ?? rule.id}</p>
          <details className="mt-2 text-muted-foreground"><summary className="cursor-pointer">Source Details</summary><span className="block break-all font-mono">{rule.id}</span><span className="block">Line {rule.sourceLine}</span></details></td>
          <td className="pr-3">{rule.locked ? <span title="Hard rules require the separate infeasibility review" className="inline-flex items-center gap-1"><LockKeyhole size={14} />Hard</span> : "Soft"}</td>
          <td className="pr-3">{rule.locked ? "—" : <input aria-label={"Weight for " + rule.id} type="number" min="1" max={catalog.maxWeight} step="1" disabled={busy}
            value={changes[rule.id]?.weight ?? rule.weight!} onChange={(event) => edit(rule, "weight", event.target.value)} className="w-32 border border-border bg-background p-2" />}</td>
          <td>{rule.locked ? "Locked" : <select aria-label={"Priority for " + rule.id} value={changes[rule.id]?.priority ?? rule.priority} disabled={busy}
            onChange={(event) => edit(rule, "priority", event.target.value)} className="border border-border bg-background p-2">{catalog.tiers.map((tier) => <option key={tier} value={tier}>{tier}</option>)}</select>}</td>
        </tr>)}</tbody></table></div></>}
      <div className="flex items-center justify-between gap-3"><span>{selected.length} changes selected</span><button type="button" disabled={busy || !valid}
        onClick={() => void propose()} className="flex items-center gap-2 border border-border px-3 py-2 disabled:opacity-50"><FileText size={16} />Review Changes</button></div>
      <details><summary className="cursor-pointer">Current CNL</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words bg-muted p-3 text-xs">{catalog.cnl}</pre></details>
    </>}
    {review && <div className="space-y-4 border-t border-border pt-5">
      <h3 className="font-semibold">{review.applied ? "Draft Revision Created" : "Review Before Creating A Draft"}</h3>
      <p className="break-all font-mono text-xs">{review.review.policy}</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="py-2">Rule</th><th>Weight</th><th>Priority</th></tr></thead><tbody>
        {review.review.changes.map((change) => { const before = review.review.beforeRules.find((row) => row.id === change.id); return <tr key={change.id} className="border-t border-border">
          <td className="max-w-xs break-words py-3 pr-3">{before?.summary ?? change.id}<span className="mt-1 block break-all font-mono text-muted-foreground">{change.id}</span></td><td>{before?.weight} → {change.weight}</td><td>{before?.priority} → {change.priority}</td></tr>; })}
      </tbody></table></div>
      <details open><summary className="cursor-pointer">Exact Source Changes</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words bg-muted p-3 text-xs">{review.review.sourceDiff}</pre></details>
      <details><summary className="cursor-pointer">CNL Before</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words bg-muted p-3 text-xs">{review.review.beforeCnl}</pre></details>
      <details><summary className="cursor-pointer">CNL After</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words bg-muted p-3 text-xs">{review.review.afterCnl}</pre></details>
      {!review.applied ? <><p className="text-xs text-muted-foreground">Expires {new Date(review.expiresAt).toLocaleString()} · Digest {review.digest.slice(0,16)}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>I reviewed the changes. Create a separate draft; keep the original policy and active solves unchanged.</span></label>
        <label className="block">Current password<input type="password" aria-label="Confirm current password" autoComplete="current-password" value={password} disabled={busy}
          onChange={(event) => setPassword(event.target.value)} className="mt-1 block w-full border border-border bg-background p-2" /></label>
        <button type="button" disabled={busy || !confirmed || !password || Date.parse(review.expiresAt) <= Date.now()} onClick={() => void apply()}
          className="flex items-center gap-2 border border-border px-3 py-2 disabled:opacity-50"><Check size={16} />Create Reviewed Draft</button>
      </> : <><dl className="space-y-2 text-xs"><dt>.rost</dt><dd className="break-all font-mono">{review.applied.policyPath}</dd>
        <dt>.cnl</dt><dd className="break-all font-mono">{review.applied.cnlPath}</dd><dt>Integrity manifest</dt><dd className="break-all font-mono">{review.applied.manifestPath}</dd></dl>
        <p role="status">Draft selection recorded for your bot. No solve started; no policy or schedule approval granted.</p></>}
    </div>}
    {busy && <p role="status">Checking the exact policy revision…</p>}
  </section>;
}
