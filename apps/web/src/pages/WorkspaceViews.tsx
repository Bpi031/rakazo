import { useEffect, useMemo, useState } from "react";
import { Bot, RefreshCw, Users } from "lucide-react";
import { withSpaceHeaders } from "../lib/rpc";
import { TeamSettingsPanel } from "./TeamSettingsPanel";
import "./workspace-motion.css";

type Person = { userId: string; name: string; email: string; role: string };
type People = { manager: boolean; userId: string; members: Person[] };
type Row = { day: string; model: string; botId: string | null; calls: number; costUsd: number | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null };
type Usage = { name: string; days: number; observedAt: string; since: string; rows: Row[]; totals: Row; bots: Array<{ id: string; name: string }> };
type Storage = { name: string; observedAt: string; scope: string; quota: { enforced: boolean; usedBytes: number | null; limitBytes: number | null };
  rows: Array<{ botId: string; name: string; shared: boolean; usage: Record<string, [number,number,boolean]> | null }>;
  attachments: { bytes: number; files: number } };
export async function workspaceApi<T>(route: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/workspace/" + route, { credentials: "include", headers: withSpaceHeaders(), signal });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Workspace data is unavailable. Refresh or check your team access.");
  return response.json() as Promise<T>;
}
const number = (n: number | null | undefined) => n == null ? "Unknown" : Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(n);
const money = (n: number | null | undefined) => n == null ? "Unknown" : "$" + n.toFixed(2);
const bytes = (n: number | null | undefined) => n == null ? "Unknown" : n >= 1e9 ? (n/1e9).toFixed(2) + " GB" : (n/1e6).toFixed(1) + " MB";
const control = "max-w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm";

function usePeople() {
  const [people, setPeople] = useState<People | null>(null); const [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); void workspaceApi<People>("people", controller.signal).then((value) => { if (!controller.signal.aborted) setPeople(value); })
    .catch(() => { if (!controller.signal.aborted) setError("Member list unavailable."); }); return () => controller.abort(); }, []);
  return { people, error };
}
function PersonPicker({ people, userId, onChange }: { people: People | null; userId: string; onChange: (id: string) => void }) {
  return people?.manager ? <select className={control} aria-label="Team member" value={userId || people.userId} onChange={(e) => onChange(e.target.value)}>
    {people.members.map((p) => <option key={p.userId} value={p.userId}>{p.name}{p.userId === people.userId ? " (you)" : ""}</option>)}
  </select> : <span className="text-sm text-muted-foreground">Your workspace</span>;
}

export function WorkspaceUsagePanel() {
  const { people, error: peopleError } = usePeople();
  const [userId, setUserId] = useState(""); const [days, setDays] = useState(30);
  const [model, setModel] = useState(""); const [bot, setBot] = useState("");
  const [metric, setMetric] = useState("totalTokens"); const [breakdown, setBreakdown] = useState("model");
  const [data, setData] = useState<Usage | null>(null); const [error, setError] = useState(""); const [revision, setRevision] = useState(0);
  useEffect(() => {
    setData(null); setError(""); const controller = new AbortController();
    const params = new URLSearchParams({ days: String(days), ...(userId ? { userId } : {}) });
    void workspaceApi<Usage>("usage?" + params, controller.signal).then((value) => { if (!controller.signal.aborted) setData(value); }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [userId, days, revision]);
  const rows = data?.rows.filter((r) => (!model || r.model === model) && (!bot || r.botId === bot)) ?? [];
  const sum = (items: Row[], field: string) => items.every((r) => typeof r[field as keyof Row] === "number") ? items.reduce((n,r) => n + Number(r[field as keyof Row]), 0) : null;
  const total = sum(rows, metric); const format = metric === "costUsd" ? money : number;
  const daily = useMemo(() => {
    if (!data) return [];
    const grouped = new Map<string, Row[]>(); for (const row of rows) grouped.set(row.day, [...(grouped.get(row.day) ?? []), row]);
    return Array.from({ length: data.days }, (_, i) => { const day = new Date(data.since); day.setUTCDate(day.getUTCDate()+i);
      const id = day.toISOString().slice(0,10); return { id, value: sum(grouped.get(id) ?? [], metric) }; });
  }, [data, model, bot, metric]);
  const grouped = new Map<string, Row[]>(); for (const row of rows) { const key = breakdown === "agent" ? row.botId ?? "unattributed" : breakdown === "day" ? row.day : row.model;
    grouped.set(key, [...(grouped.get(key) ?? []), row]); }
  const peak = Math.max(1, ...daily.map((d) => d.value ?? 0));
  const segments: string[][] = [[]];
  daily.forEach((day,index) => {
    if (day.value === null) { if (segments.at(-1)!.length) segments.push([]); return; }
    segments.at(-1)!.push(`${index / Math.max(1,daily.length-1) * 600},${160-day.value/peak*150}`);
  });
  return <section className="workspace-enter min-w-0 space-y-7 py-2" aria-label="Usage dashboard">
    <div className="flex flex-wrap items-center gap-2">
      <PersonPicker people={people} userId={userId} onChange={(id) => { setUserId(id); setModel(""); setBot(""); }}/>
      <select className={control} aria-label="Agent filter" value={bot} onChange={(e) => setBot(e.target.value)}><option value="">All agents</option>{data?.bots.map((b) => <option value={b.id} key={b.id}>{b.name}</option>)}</select>
      <select className={control} aria-label="Model filter" value={model} onChange={(e) => setModel(e.target.value)}><option value="">All models</option>{[...new Set(data?.rows.map((r) => r.model))].map((m) => <option key={m}>{m}</option>)}</select>
      <select className={control} aria-label="Usage metric" value={metric} onChange={(e) => setMetric(e.target.value)}><option value="costUsd">Cost</option><option value="totalTokens">Tokens</option><option value="calls">Calls</option></select>
      <select className={control} aria-label="Usage period" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7,30,90].map((n) => <option value={n} key={n}>{n} days</option>)}</select>
      <button className="ml-auto rounded-md p-2 hover:bg-accent" title="Refresh usage" aria-label="Refresh usage" onClick={() => setRevision((n) => n+1)}><RefreshCw size={17}/></button>
    </div>
    {(error || peopleError) && <p role="alert">{error || peopleError}</p>}
    {!data && !error && <p role="status">Loading usage…</p>}
    {data && <><div className="grid min-w-0 gap-7 lg:grid-cols-[minmax(180px,1fr)_minmax(280px,2fr)]">
      <div><p className="break-words text-[40px] font-semibold leading-tight">{format(total)}</p><p className="mt-2 text-xs text-muted-foreground">{rows.reduce((n,r) => n+r.calls,0)} calls · {metric === "costUsd" ? "Recorded cost / estimate · USD" : metric === "totalTokens" ? "Processed tokens" : "Model calls"}</p>
        <p className="mt-4 text-sm">{data.name}</p><p className="text-xs text-muted-foreground">{new Date(data.observedAt).toLocaleTimeString()} · UTC days</p></div>
      <div className="min-w-0"><h3 className="mb-3 text-sm font-medium">Daily {metric === "costUsd" ? "cost" : metric === "calls" ? "calls" : "tokens"}</h3>
        <div className="h-44 border-b border-border" role="img" aria-label="Daily usage chart">
          <svg viewBox="0 0 600 165" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
            {[10,85,160].map((y) => <line key={y} x1="0" y1={y} x2="600" y2={y} stroke="currentColor" opacity=".08" vectorEffect="non-scaling-stroke"/>)}
            {segments.filter((s) => s.length).map((points,i) => <polyline key={i} points={points.join(" ")} fill="none" stroke="#a78bfa" strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
          </svg>
        </div><div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>{daily[0]?.id}</span><span>{daily.at(-1)?.id}</span></div>
        <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Daily data</summary><table className="mt-2 w-full text-left"><tbody>{daily.map((d) => <tr key={d.id}><th className="py-1 font-normal">{d.id}</th><td className="text-right">{format(d.value)}</td></tr>)}</tbody></table></details>
      </div></div>
      <dl className="grid grid-cols-2 gap-4 border-y border-border py-5 sm:grid-cols-3 lg:grid-cols-5">{[["Processed tokens","totalTokens"],["Cached input","cacheReadTokens"],["Uncached input","inputTokens"],["Cache creation","cacheWriteTokens"],["Output","outputTokens"]].map(([label,key]) => <div key={key}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 text-xl">{number(sum(rows,key!))}</dd></div>)}</dl>
      <div><div className="mb-3 flex items-center justify-between gap-2"><h3 className="font-medium">Breakdown</h3><div role="group" aria-label="Breakdown" className="flex rounded-md border border-border p-1">{["model","agent","day"].map((key) => <button key={key} aria-pressed={breakdown === key} onClick={() => setBreakdown(key)} className={"rounded px-3 py-1 text-xs capitalize " + (breakdown === key ? "bg-accent" : "")}>{key}</button>)}</div></div>
        <div className="overflow-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="py-2 capitalize">{breakdown}</th><th>Cost</th><th>Tokens</th><th>Calls</th></tr></thead><tbody>{[...grouped].map(([key, items]) => <tr className="border-t border-border" key={key}><td className="max-w-56 break-words py-3 pr-3">{breakdown === "agent" ? data.bots.find((b) => b.id === key)?.name ?? "Removed / unattributed agent" : key}</td><td>{money(sum(items,"costUsd"))}</td><td>{number(sum(items,"totalTokens"))}</td><td>{items.reduce((n,r) => n+r.calls,0)}</td></tr>)}</tbody></table></div>
        {!rows.length && <p className="py-4 text-sm text-muted-foreground">No recorded calls in this period.</p>}
      </div><p className="text-xs text-muted-foreground">Unknown means the provider did not supply complete accounting. Cost is not an invoice.</p>
    </>}
  </section>;
}

export function WorkspaceStoragePanel() {
  const { people, error: peopleError } = usePeople(); const [userId, setUserId] = useState("");
  const [data, setData] = useState<Storage | null>(null); const [error, setError] = useState(""); const [revision, setRevision] = useState(0);
  useEffect(() => { const controller = new AbortController(); setData(null); setError("");
    void workspaceApi<Storage>("storage" + (userId ? "?userId=" + encodeURIComponent(userId) : ""), controller.signal).then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort();
  }, [userId, revision]);
  const categories = ["workspace", "Downloads"];
  const amounts = categories.map((key) => data?.rows.filter((r) => !r.shared).reduce((n,r) => n + (r.usage?.[key]?.[0] ?? 0), 0) ?? 0);
  if (data) amounts.push(data.attachments.bytes);
  const measured = amounts.reduce((n,v) => n+v,0); const complete = data?.rows.every((r) => r.shared || (r.usage && categories.every((k) => r.usage![k]?.[2])));
  return <section className="workspace-enter space-y-7 py-2" aria-label="Storage dashboard">
    <div className="flex items-center justify-between gap-2"><PersonPicker people={people} userId={userId} onChange={setUserId}/><button title="Measure storage again" aria-label="Measure storage again" className="rounded-md p-2 hover:bg-accent" onClick={() => setRevision((n) => n+1)}><RefreshCw size={17}/></button></div>
    {(error || peopleError) && <p role="alert">{error || peopleError}</p>}
    {!data && !error && <p role="status">Measuring storage…</p>}
    {data && <><div><p className="text-sm text-muted-foreground">{data.name}</p><p className="mt-2 text-[36px] font-semibold">{bytes(measured)}{!complete && <span className="ml-2 text-sm font-normal text-muted-foreground">partial</span>}</p>
      <p className="mt-2 text-xs text-muted-foreground">Measured {new Date(data.observedAt).toLocaleTimeString()} · 60-second observation window</p></div>
      <div><div className="flex h-3 overflow-hidden rounded-md bg-muted" aria-label="Storage categories">{amounts.map((n,i) => <div key={i} className={["bg-blue-500","bg-amber-500","bg-emerald-500"][i]} style={{ width: (measured ? n/measured*100 : 0) + "%" }}/>)}</div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">{["Agent workspaces","Downloads","Chat files"].map((label,i) => <div className="flex items-center gap-2" key={label}><span className={"size-2 rounded-full " + ["bg-blue-500","bg-amber-500","bg-emerald-500"][i]}/><dt>{label}</dt><dd className="ml-auto">{bytes(amounts[i])}</dd></div>)}</dl></div>
      <div className="flex flex-wrap gap-5 border-y border-border py-4 text-sm"><span>Quota {bytes(data.quota.limitBytes)}</span><span>{data.quota.enforced ? "Kernel enforced" : "Not enforced / not verified"}</span><span>Quota-accounted {bytes(data.quota.usedBytes)}</span></div>
      <div><h3 className="mb-3 font-medium">Agents</h3><ul className="divide-y divide-border rounded-lg border border-border">{data.rows.map((row) => <li className="flex items-center gap-3 p-4" key={row.botId}><Bot size={21} className="shrink-0 text-muted-foreground"/><div className="min-w-0 flex-1"><p className="break-words">{row.name}</p><p className="text-xs text-muted-foreground">{row.shared ? "Shared computer; counted once" : row.usage ? number(categories.reduce((n,k) => n+(row.usage![k]?.[1] ?? 0),0)) + " files" : "Measurement unavailable"}</p></div><span className="shrink-0 text-sm">{row.shared ? "Shared" : row.usage ? bytes(categories.reduce((n,k) => n+(row.usage![k]?.[0] ?? 0),0)) : "Unknown"}</span></li>)}</ul></div>
      <p className="text-xs text-muted-foreground">{data.scope}. No files are deleted. Workspace and published copies can occupy separate storage.</p>
    </>}
  </section>;
}

export function WorkspaceTeamPanel() {
  const { people, error } = usePeople(); const [query, setQuery] = useState("");
  return <section className="workspace-enter space-y-6 py-2">
    <div className="flex items-center gap-3"><Users size={20}/><h3 className="font-medium">{people?.manager ? "Team members" : "Your account"}</h3><span className="ml-auto text-xs text-muted-foreground">{people?.members.length ?? "—"} members</span></div>
    {error && <p role="alert">{error}</p>}
    <input className={control + " w-full"} aria-label="Search members" placeholder="Search members" value={query} onChange={(e) => setQuery(e.target.value)}/>
    <ul className="divide-y divide-border rounded-lg border border-border">{people?.members.filter((p) => (p.name+" "+p.email).toLowerCase().includes(query.toLowerCase())).map((p) => <li className="flex items-center justify-between gap-4 p-4" key={p.userId}><div className="min-w-0"><p className="break-words font-medium">{p.name}</p><p className="break-all text-xs text-muted-foreground">{p.email}</p></div><span className="text-xs capitalize text-muted-foreground">{p.role}</span></li>)}</ul>
    <TeamSettingsPanel />
  </section>;
}
