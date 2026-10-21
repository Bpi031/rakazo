import { useEffect, useRef, useState } from "react";
import { GitBranch, ScanText, SearchCheck, RefreshCw } from "lucide-react";
import { workbenchApi } from "./AgentWorkbenchPanel";

export function NativeAgentPanel({ botId, compact = false }: { botId: string; compact?: boolean }) {
  const [view, setView] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef<AbortController | null>(null),
    submitting = useRef(false);
  const refresh = async (signal = active.current?.signal) => {
    const value = await workbenchApi("native", botId, undefined, signal);
    if (!signal?.aborted) setView(value);
  };
  useEffect(() => {
    const c = new AbortController();
    active.current = c;
    setView(undefined);
    void refresh(c.signal).catch(() => {});
    const timer = setInterval(() => {
      if (!submitting.current && document.visibilityState === "visible")
        void refresh(c.signal).catch(() => {});
    }, 15000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [botId]);
  const save = async (change: any) => {
    if (!view || submitting.current) return;
    const signal = active.current?.signal;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await workbenchApi(
        "decide",
        botId,
        {
          operation: "native_settings",
          revision: view.preferences.revision,
          preferences: {
            mode: view.preferences.mode,
            persistence: view.preferences.persistence,
            action: view.preferences.action,
            ...change,
          },
        },
        signal,
      );
      await refresh(signal);
    } catch {
      if (!signal?.aborted) setError("Setting not confirmed. Refresh before retrying.");
    } finally {
      submitting.current = false;
      if (!signal?.aborted) setBusy(false);
    }
  };
  if (!view?.enabled)
    return compact ? null : (
      <p className="text-sm text-muted-foreground">Native controls unavailable.</p>
    );
  const p = view.preferences;
  const mode = (
    <div
      role="radiogroup"
      aria-label="Next agent mode"
      className="inline-flex shrink-0 rounded border border-border p-0.5"
    >
      {(["plan", "execute"] as const).map((mode) => (
        <button
          key={mode}
          role="radio"
          aria-checked={p.mode === mode}
          title={
            mode === "plan"
              ? "Next turn: scoped read-only analysis"
              : "Next turn: existing approved tools; no new solve allowance"
          }
          disabled={busy}
          className={
            "rounded px-2 py-1 text-xs capitalize " +
            (p.mode === mode ? "bg-accent text-foreground" : "text-muted-foreground")
          }
          onClick={() => void save({ mode, action: "none" })}
        >
          {mode}
        </button>
      ))}
    </div>
  );
  if (compact)
    return (
      <div className="flex min-w-0 flex-wrap gap-1">
        {mode}
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </div>
    );
  const completed = view.records.some(
    (r: any) => r.kind === "native_session" && r.status === "completed",
  );
  return (
    <section aria-label="Native agent controls" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {mode}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={p.persistence}
            disabled={busy}
            onChange={(e) => void save({ persistence: e.target.checked })}
          />
          Resume completed context
        </label>
        <button
          title="Refresh native state"
          aria-label="Refresh native state"
          className="p-2"
          onClick={() => void refresh().catch(() => setError("Refresh failed"))}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {[
          { action: "compact", label: "Compact context", Icon: ScanText },
          { action: "review", label: "Review workspace", Icon: SearchCheck },
          { action: "fork", label: "Fork conversation", Icon: GitBranch },
        ].map(({ action, label, Icon }) => (
          <button
            key={action}
            className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm disabled:opacity-40"
            disabled={busy || (action !== "review" && !completed)}
            onClick={() => void save({ action })}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Next turn{p.action !== "none" ? `: ${p.action}` : ""}. Forks are read-only discussions;
        tool inheritance is unavailable in this runtime. No solve is started or changed.
      </p>
      <div className="min-w-0 divide-y divide-border">
        {view.records.map((r: any) => (
          <details key={r.id} className="min-w-0 py-2">
            <summary className="cursor-pointer break-words text-sm">
              {r.kind.replace("native_", "")} · {r.status}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(r.payload, null, 2)}
            </pre>
          </details>
        ))}
      </div>
    </section>
  );
}
