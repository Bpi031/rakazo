import { NativePreferences } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import { GitBranch, RefreshCw, ScanText, SearchCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { useBoundSpaceId } from "../lib/query/space-rpc";
import { useManagedOperation } from "../lib/query/use-managed-operation";
import { useVisibleRefresh } from "../lib/use-visible-refresh";
import { workbenchApi } from "./AgentWorkbenchPanel";

const nativeView = z.object({
  enabled: z.boolean(),
  preferences: NativePreferences.extend({ revision: z.number().int().nonnegative() }),
  records: z.array(
    z.object({ id: z.string(), kind: z.string(), status: z.string(), payload: z.json() }),
  ),
});

export function NativeAgentPanel({ botId, compact = false }: { botId: string; compact?: boolean }) {
  const modeGroup = useId();
  const [view, setView] = useState<z.infer<typeof nativeView>>();
  const [error, setError] = useState("");
  const write = useManagedOperation();
  const busy = write.pending;
  const activeSpaceId = useBoundSpaceId();
  const active = useRef<AbortController | null>(null);
  const refresh = async (
    signal = active.current?.signal,
    spaceId = activeSpaceId,
    isCurrent: () => boolean = () => true,
  ) => {
    const value = nativeView.parse(await workbenchApi("native", botId, undefined, signal, spaceId));
    if (!signal?.aborted && isCurrent()) setView(value);
  };
  useEffect(() => {
    const c = new AbortController();
    active.current = c;
    setView(undefined);
    void bestEffort("read native agent state", refresh(c.signal));
    return () => c.abort();
  }, [botId, activeSpaceId]);
  useVisibleRefresh(
    () => {
      if (!busy) void bestEffort("refresh native agent state", refresh());
    },
    busy ? null : 15_000,
  );
  const save = (change: Partial<z.infer<typeof NativePreferences>>) => {
    if (!view) return;
    write.run(async (scope) => {
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
          undefined,
          scope.spaceId,
        );
      } catch {
        if (scope.isCurrent()) setError("Setting not confirmed. Refresh before retrying.");
        return;
      }
      if (!scope.isCurrent()) return;
      try {
        await refresh(active.current?.signal, scope.spaceId, scope.isCurrent);
      } catch {
        if (scope.isCurrent()) setError("Setting saved. Refresh to load the current state.");
      }
    });
  };
  if (!view?.enabled)
    return compact ? null : (
      <p className="text-body text-muted-foreground">Native controls unavailable.</p>
    );
  const p = view.preferences;
  const mode = (
    <fieldset
      aria-label="Next agent mode"
      className="inline-flex min-w-0 shrink-0 rounded border border-border p-0.5"
    >
      {(["plan", "execute"] as const).map((mode) => (
        <label
          key={mode}
          title={
            mode === "plan"
              ? "Next turn: scoped read-only analysis"
              : "Next turn: existing approved tools; no new solve allowance"
          }
          className={
            "rounded px-2 py-1 text-label capitalize has-[:focus-visible]:outline has-[:disabled]:opacity-50 " +
            (p.mode === mode ? "bg-accent text-foreground" : "text-muted-foreground")
          }
        >
          <input
            type="radio"
            name={modeGroup}
            value={mode}
            disabled={busy}
            checked={p.mode === mode}
            className="sr-only"
            onChange={() => void save({ mode, action: "none" })}
          />
          {mode}
        </label>
      ))}
    </fieldset>
  );
  if (compact)
    return (
      <div className="flex min-w-0 flex-wrap gap-1">
        {mode}
        {error && (
          <span role="alert" className="text-label text-destructive">
            {error}
          </span>
        )}
      </div>
    );
  const completed = view.records.some(
    (r) => r.kind === "native_session" && r.status === "completed",
  );
  return (
    <section aria-label="Native agent controls" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {mode}
        <label className="flex items-center gap-2 text-body">
          <input
            type="checkbox"
            checked={p.persistence}
            disabled={busy}
            onChange={(e) => void save({ persistence: e.target.checked })}
          />
          Resume completed context
        </label>
        <button
          type="button"
          title="Refresh native state"
          aria-label="Refresh native state"
          className="p-2"
          onClick={() => void refresh().catch(() => setError("Refresh failed"))}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error && (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(
          [
            { action: "compact", label: "Compact context", Icon: ScanText },
            { action: "review", label: "Review workspace", Icon: SearchCheck },
            { action: "fork", label: "Fork conversation", Icon: GitBranch },
          ] as const
        ).map(({ action, label, Icon }) => (
          <button
            type="button"
            key={action}
            className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-body disabled:opacity-40"
            disabled={busy || (action !== "review" && !completed)}
            onClick={() => void save({ action })}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      <p className="text-label text-muted-foreground">
        Next turn{p.action !== "none" ? `: ${p.action}` : ""}. Forks are read-only discussions; tool
        inheritance is unavailable in this runtime. No solve is started or changed.
      </p>
      <div className="min-w-0 divide-y divide-border">
        {view.records.map((r) => (
          <details key={r.id} className="min-w-0 py-2">
            <summary className="cursor-pointer break-words text-body">
              {r.kind.replace("native_", "")}
              <span className="ml-2 text-muted-foreground">{r.status}</span>
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-label">
              {JSON.stringify(r.payload, null, 2)}
            </pre>
          </details>
        ))}
      </div>
    </section>
  );
}
