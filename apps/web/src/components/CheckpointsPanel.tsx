import type { CheckpointStatus, CheckpointView } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { checkpointError, useCheckpointI18n } from "../lib/checkpoint-i18n";
import { checkpointApi, checkpointNeedsReload } from "../lib/checkpoints";
import { CheckpointTree } from "./CheckpointTree";

type RestoreResult = {
  ok: boolean;
  generation: number;
  branchId: string;
};

export function CheckpointsPanel({
  botId,
  onRestored = () => window.location.reload(),
  onBusyChange,
  workspaceBusy = false,
}: {
  botId: string;
  onRestored?: () => void;
  onBusyChange?: (busy: boolean) => void;
  workspaceBusy?: boolean;
}) {
  const { copy } = useCheckpointI18n();
  const [view, setView] = useState<CheckpointView>();
  const [loadError, setLoadError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState<{ id: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const revision = useRef<string | undefined>(undefined);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  busyRef.current = busy;
  const operationBusy = busy || workspaceBusy;
  const error = operationError || loadError;
  const load = useCallback(async () => {
    const signal = controller.current?.signal;
    const value = await checkpointApi<CheckpointView>("", botId, undefined, signal);
    if (signal?.aborted || !mounted.current) return;
    revision.current = value.revision;
    setView(value);
    setLoadError("");
  }, [botId]);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    mounted.current = true;
    void load().catch((value: unknown) => {
      if (!abort.signal.aborted)
        setLoadError(value instanceof Error ? checkpointError(value.message) : copy.loadError);
    });
    let polling = false;
    async function poll() {
      if (polling || busyRef.current || abort.signal.aborted) return;
      polling = true;
      try {
        const status = await checkpointApi<CheckpointStatus>(
          "/status",
          botId,
          undefined,
          abort.signal,
        );
        if (!abort.signal.aborted && !busyRef.current && status.revision !== revision.current)
          await load();
      } catch {
        /* Keep the current tree usable during temporary connection failures. */
      } finally {
        polling = false;
      }
    }
    const timer = window.setInterval(() => void poll(), 4000);
    const focus = () => {
      if (document.visibilityState === "visible") void poll();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      abort.abort();
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [load, copy]);

  async function run(operation: () => Promise<void>) {
    if (busyRef.current || workspaceBusy) return;
    busyRef.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setOperationError("");
    try {
      await operation();
    } catch (value) {
      if (mounted.current)
        setOperationError(
          value instanceof Error ? checkpointError(value.message) : copy.operationError,
        );
      await load().catch(() => undefined);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
      onBusyChange?.(false);
    }
  }
  async function restore() {
    if (!target || !view) return;
    const result = await checkpointApi<RestoreResult>(
      `/${encodeURIComponent(target.id)}/rollback`,
      botId,
      { checkpointId: target.id, expectedGeneration: view.generation },
    );
    if (!result.ok) throw new Error(copy.restoreError);
    if (mounted.current) {
      setTarget(null);
      onRestored();
    }
  }

  return (
    <section aria-label={copy.title} className="space-y-4">
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {view?.blocked && (
        <p role="alert" className="text-sm text-destructive">
          {copy.blocked}
        </p>
      )}
      {!view && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {copy.loading}
        </p>
      )}
      <div className="flex gap-2">
        <Input
          aria-label={copy.name}
          placeholder={copy.namePlaceholder}
          value={name}
          maxLength={120}
          disabled={operationBusy || !view || view.blocked}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button
          disabled={operationBusy || !view || view.blocked}
          onClick={() =>
            void run(async () => {
              await checkpointApi("", botId, {
                ...(name.trim() ? { label: name.trim() } : {}),
                expectedGeneration: view!.generation,
              });
              if (mounted.current) setName("");
              await load();
            })
          }
        >
          {copy.set}
        </Button>
      </div>
      {target && (
        <div
          role="alertdialog"
          aria-labelledby="checkpoint-confirm-title"
          aria-describedby="checkpoint-confirm-description"
          className="space-y-3 rounded-md border border-border p-3"
        >
          <h3 id="checkpoint-confirm-title" className="text-sm font-medium">
            {copy.confirm}
          </h3>
          <p id="checkpoint-confirm-description" className="text-sm text-muted-foreground">
            {copy.description}
          </p>
          <div className="flex gap-2">
            <Button disabled={operationBusy} onClick={() => void run(restore)}>
              {copy.restore}
            </Button>
            <Button variant="outline" disabled={operationBusy} onClick={() => setTarget(null)}>
              {copy.cancel}
            </Button>
          </div>
        </div>
      )}
      {operationBusy && (
        <p role="status" className="text-sm text-muted-foreground">
          {copy.working}
        </p>
      )}
      {view?.checkpoints.length === 0 && (
        <p className="text-sm text-muted-foreground">{copy.empty}</p>
      )}
      {view && view.checkpoints.length > 0 && (
        <CheckpointTree
          view={view}
          disabled={operationBusy}
          selectedId={target?.id}
          onSelect={(item) => setTarget({ id: item.id })}
        />
      )}
    </section>
  );
}

/** Mounted for the active managed Bot even while the timeline is closed. */
export function CheckpointGenerationMonitor({
  botId,
  onBlockedChange,
  onReload = () => window.location.reload(),
}: {
  botId: string;
  onBlockedChange: (blocked: boolean) => void;
  onReload?: () => void;
}) {
  const callbacks = useRef({ onBlockedChange, onReload });
  callbacks.current = { onBlockedChange, onReload };
  useEffect(() => {
    const abort = new AbortController();
    let previous: CheckpointStatus | undefined;
    let pending = false;
    let reloading = false;
    async function poll() {
      if (pending || reloading || abort.signal.aborted) return;
      pending = true;
      try {
        const value = await checkpointApi<CheckpointStatus>(
          "/status",
          botId,
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        callbacks.current.onBlockedChange(value.blocked);
        if (previous && checkpointNeedsReload(previous, value)) {
          reloading = true;
          callbacks.current.onReload();
        }
        previous = value;
      } catch {
        /* Temporary connection failures must not reload a healthy page. */
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    const refresh = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", refresh);
    return () => {
      abort.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [botId]);
  return null;
}
