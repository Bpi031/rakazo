import type { CheckpointStatus, CheckpointView } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import { Button, Input } from "@rakazo/ui-web";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { checkpointError, useCheckpointI18n } from "../lib/checkpoint-i18n";
import { checkpointApi, checkpointNeedsReload } from "../lib/checkpoints";
import { useSave } from "../lib/query/query";
import { selectedSpaceId } from "../lib/query/rpc";
import { useBoundSpaceId } from "../lib/query/space-rpc";
import { useVisibleRefresh } from "../lib/use-visible-refresh";
import { CheckpointTree } from "./CheckpointTree";

type RestoreResult = {
  ok: boolean;
  generation: number;
  branchId: string;
};
type CheckpointWrite =
  | { kind: "save"; generation: number; label: string }
  | { kind: "restore"; id: string; generation: number; revision: string };

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
  const { copy, locale } = useCheckpointI18n();
  const confirmId = useId();
  const [view, setView] = useState<CheckpointView>();
  const [loadError, setLoadError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [savedListDelayed, setSavedListDelayed] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState<{ id: string; generation: number; revision: string } | null>(
    null,
  );
  const controller = useRef<AbortController | null>(null);
  const refreshStatus = useRef<(() => Promise<void>) | undefined>(undefined);
  const listRequest = useRef(0);
  const revision = useRef<string | undefined>(undefined);
  const pendingRevision = useRef<string | undefined>(undefined);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const awaitingSavedList = useRef(false);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const boundSpaceId = useBoundSpaceId();
  const spaceId = boundSpaceId === undefined ? selectedSpaceId() : boundSpaceId;
  const write = useSave<CheckpointWrite>({
    saveScoped: async (input, _client, scope) => {
      busyRef.current = true;
      onBusyChange?.(true);
      setOperationError("");
      try {
        if (input.kind === "save") {
          await checkpointApi(
            "",
            botId,
            {
              ...(input.label ? { label: input.label } : {}),
              expectedGeneration: input.generation,
            },
            undefined,
            scope.spaceId,
          );
          if (!scope.isCurrent()) return;
          setName("");
          // Once acknowledged, retry only the read.
          awaitingSavedList.current = true;
          setRefreshing(true);
          try {
            await load();
          } catch {
            if (scope.isCurrent()) setSavedListDelayed(true);
          }
          return;
        }
        const result = await checkpointApi<RestoreResult>(
          `/${encodeURIComponent(input.id)}/rollback`,
          botId,
          {
            checkpointId: input.id,
            expectedGeneration: input.generation,
            expectedRevision: input.revision,
          },
          undefined,
          scope.spaceId,
        );
        if (!result.ok) throw new Error(copy.restoreError);
        if (scope.isCurrent()) {
          setTarget(null);
          onRestored();
        }
      } catch (value) {
        if (scope.isCurrent()) {
          const message =
            value instanceof Error ? checkpointError(value.message) : copy.operationError;
          if (message === copy.stale || message === copy.incomplete) setTarget(null);
          setOperationError(message);
          await bestEffort("refresh checkpoints after restore attempt", load());
        }
        throw value;
      } finally {
        busyRef.current = false;
        onBusyChange?.(false);
      }
    },
  });
  const busy = write.pending;
  const operationBusy = busy || workspaceBusy || refreshing;
  const error = operationError || loadError;
  const selected = target ? view?.checkpoints.find((item) => item.id === target.id) : undefined;
  const confirmationStale =
    target !== null &&
    (!selected ||
      refreshing ||
      target.generation !== view?.generation ||
      target.revision !== view?.revision);
  useEffect(() => {
    if (target) {
      cancelButton.current?.focus();
    } else {
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [target]);
  useEffect(() => {
    if (confirmationStale && !busyRef.current) {
      setTarget(null);
      setOperationError(copy.stale);
    }
  }, [confirmationStale, busy, copy.stale]);
  const load = useCallback(async () => {
    const signal = controller.current?.signal;
    const request = ++listRequest.current;
    const superseded = () => signal?.aborted || !mounted.current || request !== listRequest.current;
    let value: CheckpointView;
    try {
      value = await checkpointApi<CheckpointView>("", botId, undefined, signal, spaceId);
    } catch (error) {
      if (superseded()) return;
      throw error;
    }
    if (superseded()) return;
    if (pendingRevision.current !== undefined && value.revision !== pendingRevision.current) return;
    pendingRevision.current = undefined;
    awaitingSavedList.current = false;
    setRefreshing(false);
    setSavedListDelayed(false);
    revision.current = value.revision;
    setView(value);
    setLoadError("");
  }, [botId, spaceId]);
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
          spaceId,
        );
        if (
          !abort.signal.aborted &&
          !busyRef.current &&
          (status.revision !== revision.current ||
            pendingRevision.current !== undefined ||
            awaitingSavedList.current)
        ) {
          pendingRevision.current = status.revision;
          setRefreshing(true);
          await load();
        }
      } catch {
        /* Once known stale, keep actions disabled until a matching list arrives. */
      } finally {
        polling = false;
      }
    }
    refreshStatus.current = poll;
    return () => {
      abort.abort();
      mounted.current = false;
      refreshStatus.current = undefined;
    };
  }, [load, copy]);
  useVisibleRefresh(() => void refreshStatus.current?.(), 4000, true);

  function submit(input: CheckpointWrite) {
    if (
      busyRef.current ||
      workspaceBusy ||
      pendingRevision.current !== undefined ||
      awaitingSavedList.current
    )
      return;
    write.run(input);
  }

  return (
    <section aria-label={copy.title} aria-busy={refreshing || busy} className="space-y-4">
      {error && (
        <p role="alert" className="break-words text-body text-destructive">
          {error}
        </p>
      )}
      {view?.blocked && (
        <p role="alert" className="text-body text-destructive">
          {copy.blocked}
        </p>
      )}
      {!view && !error && (
        <p role="status" className="text-body text-muted-foreground">
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
          onClick={() => {
            if (view && !view.blocked)
              submit({ kind: "save", generation: view.generation, label: name.trim() });
          }}
        >
          {copy.set}
        </Button>
      </div>
      {target && selected && (
        <div
          role="alertdialog"
          aria-labelledby={`${confirmId}-title`}
          aria-describedby={`${confirmId}-target ${confirmId}-description`}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || operationBusy) return;
            event.stopPropagation();
            setTarget(null);
          }}
          className="space-y-3 rounded-md border border-border p-3"
        >
          <h3 id={`${confirmId}-title`} className="text-body font-medium">
            {copy.confirm}
          </h3>
          <p
            id={`${confirmId}-target`}
            className="flex flex-wrap items-baseline gap-x-2 break-words text-body"
          >
            <strong className="min-w-0">{selected.label || copy.kinds[selected.kind]}</strong>
            <time dateTime={selected.createdAt} className="text-label text-muted-foreground">
              {new Date(selected.createdAt).toLocaleString(locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </p>
          <p id={`${confirmId}-description`} className="text-body text-muted-foreground">
            {copy.description}
          </p>
          <div className="flex gap-2">
            <Button
              disabled={operationBusy || confirmationStale}
              onClick={() => {
                if (target && !confirmationStale) submit({ kind: "restore", ...target });
              }}
            >
              {copy.restore}
            </Button>
            <Button
              ref={cancelButton}
              variant="outline"
              disabled={operationBusy}
              onClick={() => setTarget(null)}
            >
              {copy.cancel}
            </Button>
          </div>
        </div>
      )}
      {(operationBusy || savedListDelayed) && (
        <p role="status" className="text-body text-muted-foreground">
          {savedListDelayed ? copy.savedListDelayed : copy.working}
        </p>
      )}
      {view?.checkpoints.length === 0 && (
        <p className="text-body text-muted-foreground">{copy.empty}</p>
      )}
      {view && view.checkpoints.length > 0 && (
        <CheckpointTree
          view={view}
          disabled={operationBusy || target !== null}
          selectedId={target?.id}
          onSelect={(item, trigger) => {
            if (target || pendingRevision.current !== undefined || awaitingSavedList.current)
              return;
            returnFocus.current = trigger;
            setOperationError("");
            setTarget({ id: item.id, generation: view.generation, revision: view.revision });
          }}
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
  const boundSpaceId = useBoundSpaceId();
  const spaceId = boundSpaceId === undefined ? selectedSpaceId() : boundSpaceId;
  const callbacks = useRef({ onBlockedChange, onReload });
  const refreshStatus = useRef<(() => Promise<void>) | undefined>(undefined);
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
          spaceId,
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
    refreshStatus.current = poll;
    return () => {
      abort.abort();
      refreshStatus.current = undefined;
    };
  }, [botId, spaceId]);
  useVisibleRefresh(() => void refreshStatus.current?.(), 5000, true);
  return null;
}
