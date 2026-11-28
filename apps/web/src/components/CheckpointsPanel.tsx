import type { CheckpointStatus, CheckpointView } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
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
type RenameTarget = { id: string; target: "checkpoint" | "branch"; revision: string };
type CheckpointWrite =
  | { kind: "save"; generation: number; label: string }
  | ({ kind: "rename"; label: string } & RenameTarget)
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
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [newName, setNewName] = useState("");
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
        if (input.kind === "save" || input.kind === "rename") {
          if (input.kind === "save")
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
          else {
            const id = encodeURIComponent(input.id);
            const branch = input.target === "branch";
            await checkpointApi(
              `/${branch ? "branches/" : ""}${id}/rename`,
              botId,
              {
                ...(branch ? { branchId: input.id } : { checkpointId: input.id }),
                expectedRevision: input.revision,
                label: input.label,
              },
              undefined,
              scope.spaceId,
            );
          }
          if (!scope.isCurrent()) return;
          if (input.kind === "save") setName("");
          else setRenameTarget(undefined);
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
          if (message === copy.stale) setRenameTarget(undefined);
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
  const renameStale =
    renameTarget !== undefined &&
    (refreshing || renameTarget.revision !== view?.revision || view.blocked);
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
  useEffect(() => {
    if (renameStale && !busyRef.current) {
      setRenameTarget(undefined);
      setOperationError(copy.stale);
    }
  }, [renameStale, busy, copy.stale]);
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

  function openRename(item: Omit<RenameTarget, "revision">, label: string) {
    if (!view || view.blocked || operationBusy || target) return;
    setNewName(label);
    setOperationError("");
    setRenameTarget({ ...item, revision: view.revision });
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
      <Dialog
        open={renameTarget !== undefined}
        onOpenChange={(open) => {
          if (!open && !busyRef.current) setRenameTarget(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {renameTarget?.target === "branch" ? copy.renameBranch : copy.rename}
          </DialogTitle>
          <DialogDescription>
            {renameTarget?.target === "branch"
              ? copy.renameBranchDescription
              : copy.renameDescription}
          </DialogDescription>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (renameTarget && !renameStale && newName.trim())
                submit({ kind: "rename", ...renameTarget, label: newName.trim() });
            }}
          >
            <Input
              aria-label={renameTarget?.target === "branch" ? copy.branchNameField : copy.name}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={120}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={operationBusy || renameStale || !newName.trim()}>
                {copy.saveName}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setRenameTarget(undefined)}
              >
                {copy.cancel}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
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
          disabled={operationBusy || target !== null || renameTarget !== undefined}
          viewportId={`${spaceId ?? ""}:${botId}`}
          onRename={(item) => openRename({ id: item.id, target: "checkpoint" }, item.label ?? "")}
          onRenameBranch={(id, label) => openRename({ id, target: "branch" }, label)}
          onRestore={(item, trigger) => {
            if (target || pendingRevision.current !== undefined || awaitingSavedList.current)
              return;
            returnFocus.current = trigger ?? null;
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
