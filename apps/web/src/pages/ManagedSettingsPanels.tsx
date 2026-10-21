import { useEffect, useState } from "react";
import type { Bot, ModelCatalogEntry } from "@rakazo/contracts";
import { RefreshCw } from "lucide-react";
import { rpc, withSpaceHeaders } from "../lib/rpc";

type Budget = { resetsAt: number; models: Array<{ model: string; calls: number; outputReserved: number;
  knownUsageCalls: number; inputTokens: number | null; outputTokens: number | null;
  limits: { calls: number; output_tokens: number } }> };

export function ManagedModelsPanel() {
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [budgetError, setBudgetError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [saved, setSaved] = useState("");
  async function refresh() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/managed-models/usage", { credentials: "include", headers: withSpaceHeaders() });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error();
      setBudget(await response.json() as Budget); setBudgetError("");
    } catch { setBudget(null); setBudgetError("Usage unavailable; existing limits remain enforced."); }
    finally { setRefreshing(false); }
  }
  useEffect(() => {
    let live = true;
    void Promise.all([rpc.models.list(), rpc.bots.list()]).then(([catalog, rows]) => {
      if (live) { setModels(catalog); setBots(rows); setReady(true); }
    }).catch(() => { if (live) setError("Models could not be loaded. Please try again."); });
    return () => { live = false; };
  }, []);
  useEffect(() => { void refresh(); }, []);
  async function choose(botId: string, modelId: string) {
    if (busy || (modelId && !models.some((m) => m.id === modelId))) return;
    setBusy(true); setError(""); setSaved("");
    try {
      const updated = await rpc.bots.update({ botId, modelProvider: modelId ? "codex-foundry" : null,
        modelId: modelId || null, thinkingLevel: null });
      setBots((rows) => rows.map((bot) => bot.id === botId ? updated : bot));
      setSaved("Saved for the next agent turn. Active roster jobs are unchanged.");
    } catch { setError("The model choice was not saved. Please try again."); }
    finally { setBusy(false); }
  }
  return <section className="space-y-5 p-5 text-sm">
    <h2 className="text-base font-semibold">Available Models</h2>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {saved && <p role="status">{saved}</p>}
    {!ready && !error && <p role="status">Loading models…</p>}
    <ul className="divide-y divide-border">{models.map((model) => <li key={model.id} className="py-2">{model.label}</li>)}</ul>
    {ready && <><h3 className="font-medium">Your Bots</h3>
      {!bots.length && <p>No bots yet.</p>}
      {bots.map((bot) => <label key={bot.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3">
        <span className="min-w-0 break-words">{bot.name}</span>
        <select aria-label={"Model for " + bot.name} className="max-w-full border border-border bg-background p-2"
          disabled={busy} value={bot.modelId ?? ""} onChange={(event) => void choose(bot.id, event.target.value)}>
          <option value="">Space default</option>
          {bot.modelId && !models.some((model) => model.id === bot.modelId) && <option value={bot.modelId} disabled>Unavailable model</option>}
          {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>)}
      <dl className="grid gap-2 text-muted-foreground"><div><dt className="inline font-medium">Selection: </dt><dd className="inline">Next turn</dd></div>
        <div><dt className="inline font-medium">Workspace and history: </dt><dd className="inline">Same bot</dd></div>
        <div><dt className="inline font-medium">Provider fallback: </dt><dd className="inline">Disabled</dd></div></dl>
    </>}
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">Your Daily Model Allowance</h3>
      <button type="button" title="Refresh model usage" aria-label="Refresh model usage" disabled={refreshing}
        onClick={() => void refresh()} className="p-2 disabled:opacity-50"><RefreshCw size={16} /></button></div>
    {budgetError && <p role="alert">{budgetError}</p>}
    {!budget && !budgetError && <p role="status">Loading usage…</p>}
    {budget && <><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>
      <th className="py-2 pr-3">Model</th><th className="pr-3">Calls / Limit</th><th className="pr-3">Output Reserved / Limit</th><th>Reported Input / Output</th>
    </tr></thead><tbody>{budget.models.filter((row) => models.some((model) => model.id === row.model)).map((row) => <tr key={row.model} className="border-t border-border">
      <td className="py-3 pr-3">{models.find((model) => model.id === row.model)?.label}
        {(row.calls >= row.limits.calls || row.outputReserved >= row.limits.output_tokens) && <span className="block text-red-700">Limit reached</span>}</td>
      <td className="pr-3">{row.calls.toLocaleString()} / {row.limits.calls.toLocaleString()}</td>
      <td className="pr-3">{row.outputReserved.toLocaleString()} / {row.limits.output_tokens.toLocaleString()}</td>
      <td>{row.inputTokens?.toLocaleString() ?? "Unavailable"} / {row.outputTokens?.toLocaleString() ?? "Unavailable"}
        <span className="block text-muted-foreground">{row.knownUsageCalls} of {row.calls} calls reported</span></td>
    </tr>)}</tbody></table></div><p className="text-xs text-muted-foreground">Resets {new Date(budget.resetsAt * 1000).toLocaleString()} · UTC day</p></>}
  </section>;
}

export function ManagedMemoryPanel() {
  return <section className="space-y-4 p-5 text-sm">
    <h2 className="text-base font-semibold">Memory</h2>
    <dl className="space-y-3"><div><dt className="font-medium">Workspace memory</dt><dd>MEMORY.md · Available</dd></div>
      <div><dt className="font-medium">Semantic recall</dt><dd>Not enabled by the operator</dd></div></dl>
  </section>;
}
