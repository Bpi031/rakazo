import type { CheckpointListItem, CheckpointView } from "@rakazo/contracts";
import { botColors } from "@rakazo/ui-tokens";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  OptionSelect,
} from "@rakazo/ui-web";
import { ArrowUp, Copy, GitBranch, MoreHorizontal, Pencil, RotateCcw, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCheckpointI18n } from "../lib/checkpoint-i18n";
import { useCopyText } from "../lib/copy-text";

const laneWidth = 12;
const laneInset = 10;
const connectedLanes = 5;
const rowHeight = 56;
const date = (value: string, locale: string) =>
  new Date(value).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function readViewport(key?: string) {
  try {
    const value = key ? JSON.parse(sessionStorage.getItem(key) ?? "null") : null;
    return {
      top: Number.isFinite(value?.top) && value.top >= 0 ? value.top : 0,
      branch: typeof value?.branch === "string" ? value.branch : "",
      showTurns: value?.showTurns === true,
    };
  } catch {
    return { top: 0, branch: "", showTurns: false };
  }
}

export function checkpointTreeLayout(view: CheckpointView) {
  const byId = new Map(view.checkpoints.map((item) => [item.id, item]));
  const items = [...view.checkpoints].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const visited = new Set<string>();
  const ordered: CheckpointListItem[] = [];
  // Oldest first so new rescue checkpoints never shift earlier rows.
  for (const item of items) {
    const path: CheckpointListItem[] = [];
    let cursor: CheckpointListItem | undefined = item;
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      path.push(cursor);
      cursor = byId.get(cursor.parentCheckpointId ?? "");
    }
    while (path.length) ordered.push(path.pop()!);
  }
  const branchColors = new Map<string, number>();
  const lastRow = Array.from({ length: connectedLanes }, () => -1);
  const positions = new Map<string, { column: number; row: number }>();
  let furthestColumn = 0;
  const nodes = ordered.map((item, row) => {
    if (!branchColors.has(item.branchId)) branchColors.set(item.branchId, branchColors.size);
    const parentId = item.parentCheckpointId ?? "";
    const parent = positions.get(parentId);
    const sameBranch = byId.get(parentId)?.branchId === item.branchId;
    // Reuse columns only when a new line fits without overwriting a prior node or line.
    const column = parent
      ? sameBranch && lastRow[parent.column] === parent.row
        ? parent.column
        : lastRow.findIndex((end, lane) => lane !== parent.column && end < parent.row)
      : 0;
    const reference = column < 0;
    const visualColumn = reference ? connectedLanes : column;
    if (!reference) lastRow[column] = row;
    positions.set(item.id, { column: visualColumn, row });
    furthestColumn = Math.max(furthestColumn, visualColumn);
    return {
      item,
      x: laneInset + visualColumn * laneWidth,
      y: (row + 0.5) * rowHeight,
      color: botColors[branchColors.get(item.branchId)! % botColors.length]!,
      reference,
    };
  });
  return {
    branches: [...branchColors.keys()],
    nodes,
    width: laneInset * 2 + furthestColumn * laneWidth,
    height: nodes.length * rowHeight,
  };
}

export function filterCheckpointTree(view: CheckpointView, branch: string, showTurns: boolean) {
  const byId = new Map(view.checkpoints.map((item) => [item.id, item]));
  const ancestry = new Set<string>();
  if (branch) {
    const origin = view.branches.find(({ id }) => id === branch)?.parentCheckpointId;
    const starts = view.checkpoints.filter(
      (item) => item.branchId === branch || item.id === origin,
    );
    for (const item of starts) {
      let cursor: CheckpointListItem | undefined = item;
      while (cursor && !ancestry.has(cursor.id)) {
        ancestry.add(cursor.id);
        cursor = byId.get(cursor.parentCheckpointId ?? "");
      }
    }
  }
  const visible = view.checkpoints.filter(
    (item) =>
      (!branch || ancestry.has(item.id)) && (showTurns || item.kind !== "auto_turn_boundary"),
  );
  const ids = new Set(visible.map((item) => item.id));
  const resolved = new Map<string, string | null>();
  function visibleParent(id: string | null) {
    const skipped = new Set<string>();
    while (id && !ids.has(id) && !resolved.has(id)) {
      if (skipped.has(id)) return null;
      skipped.add(id);
      id = byId.get(id)?.parentCheckpointId ?? null;
    }
    const parent = id && !ids.has(id) ? resolved.get(id)! : id;
    for (const hidden of skipped) resolved.set(hidden, parent);
    return parent;
  }
  return {
    ...view,
    checkpoints: visible.map((item) => ({
      ...item,
      parentCheckpointId: visibleParent(item.parentCheckpointId),
    })),
  };
}

function branchNames(
  view: CheckpointView,
  copy: ReturnType<typeof useCheckpointI18n>["copy"],
  locale: string,
) {
  const branches = new Map(view.branches.map((branch) => [branch.id, branch]));
  const items = new Map(view.checkpoints.map((point) => [point.id, point]));
  const history = checkpointTreeLayout(view);
  const originByBranch = new Map<string, CheckpointListItem>();
  for (const { item } of history.nodes) {
    const parent = items.get(item.parentCheckpointId ?? "");
    if (parent && parent.branchId !== item.branchId && !originByBranch.has(item.branchId))
      originByBranch.set(item.branchId, parent);
  }
  const ids = new Set([
    ...branches.keys(),
    ...history.branches,
    ...(view.activeBranchId ? [view.activeBranchId] : []),
  ]);
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const id of ids) {
    const branch = branches.get(id);
    const origin = items.get(branch?.parentCheckpointId ?? "") ?? originByBranch.get(id);
    const label = origin?.label?.replace(/\s+/g, " ").trim();
    const name =
      branch?.label ||
      (label
        ? copy.branchFrom(label.length > 54 ? `${label.slice(0, 53)}…` : label)
        : origin
          ? copy.branchRestoredAt(date(origin.createdAt, locale))
          : branch?.parentCheckpointId
            ? copy.restoredBranch
            : copy.originalBranch);
    let unique = name;
    for (let number = 2; used.has(unique); number++) unique = `${name} (${number})`;
    used.add(unique);
    names.set(id, unique);
  }
  return names;
}

function edgePath(parent: { x: number; y: number }, node: { x: number; y: number }) {
  if (parent.x === node.x) return `M ${parent.x} ${parent.y} V ${node.y}`;
  // Join near the fork, then follow the destination lane instead of drawing a long diagonal.
  const elbow = parent.y + rowHeight / 2;
  const entry = node.x - Math.sign(node.x - parent.x) * 5;
  return `M ${parent.x} ${parent.y} V ${elbow - 5} Q ${parent.x} ${elbow} ${parent.x + Math.sign(node.x - parent.x) * 5} ${elbow} H ${entry} Q ${node.x} ${elbow} ${node.x} ${elbow + 5} V ${node.y}`;
}

export function CheckpointTree({
  view,
  disabled,
  onRename,
  onRenameBranch,
  onRestore,
  viewportId,
}: {
  view: CheckpointView;
  disabled: boolean;
  onRename: (item: CheckpointListItem) => void;
  onRenameBranch?: (id: string, displayName: string) => void;
  onRestore: (item: CheckpointListItem, trigger?: HTMLButtonElement) => void;
  viewportId?: string;
}) {
  const { copy, locale } = useCheckpointI18n();
  const history = useRef<HTMLElement>(null);
  const viewportKey = viewportId ? `rakazo:checkpoint-viewport:${viewportId}` : undefined;
  const [branch, setBranch] = useState(() => readViewport(viewportKey).branch);
  const [showTurns, setShowTurns] = useState(() => readViewport(viewportKey).showTurns);
  const [selectedId, setSelectedId] = useState<string>();
  const [contextId, setContextId] = useState<string>();
  const [copied, copyText] = useCopyText();
  const names = useMemo(() => branchNames(view, copy, locale), [view, copy, locale]);
  const allBranches = useMemo(
    () =>
      [
        ...new Set([
          ...view.checkpoints.map((item) => item.branchId),
          ...(view.activeBranchId ? [view.activeBranchId] : []),
        ]),
      ].sort((a, b) => names.get(a)!.localeCompare(names.get(b)!, locale)),
    [view, names, locale],
  );
  const branchFilter = allBranches.includes(branch) ? branch : "";
  const hasTurns = view.checkpoints.some((item) => item.kind === "auto_turn_boundary");
  const onlyRecoveryTurns =
    view.blocked && view.checkpoints.every((item) => item.kind === "auto_turn_boundary");
  const layout = useMemo(
    () =>
      checkpointTreeLayout(
        filterCheckpointTree(view, branchFilter, showTurns || onlyRecoveryTurns),
      ),
    [view, branchFilter, showTurns, onlyRecoveryTurns],
  );
  const positions = new Map(layout.nodes.map((node) => [node.item.id, node]));
  const selectedNode = selectedId ? positions.get(selectedId) : undefined;
  const selected = selectedNode?.item;
  const linkedParent =
    selectedNode?.reference && selected?.parentCheckpointId
      ? positions.get(selected.parentCheckpointId)?.item
      : undefined;
  const branchLabel = (id: string) =>
    (names.get(id) ?? copy.restoredBranch) +
    (id === view.activeBranchId ? ` (${copy.currentBranch})` : "");
  const editableBranch = (id: string) =>
    !!onRenameBranch && view.branches.some((item) => item.id === id);
  function renameBranch(id: string) {
    onRenameBranch?.(
      id,
      view.branches.find((item) => item.id === id)?.label ?? names.get(id) ?? "",
    );
  }

  useLayoutEffect(() => {
    if (history.current && viewportKey) history.current.scrollTop = readViewport(viewportKey).top;
  }, [viewportKey]);

  function saveViewport(nextBranch = branchFilter, nextTurns = showTurns) {
    if (!viewportKey) return;
    try {
      sessionStorage.setItem(
        viewportKey,
        JSON.stringify({
          top: history.current?.scrollTop ?? 0,
          branch: nextBranch,
          showTurns: nextTurns,
        }),
      );
    } catch {
      // Restore remains available when storage is disabled.
    }
  }

  function changeFilter(nextBranch: string, nextTurns: boolean) {
    setBranch(nextBranch);
    setShowTurns(nextTurns);
    setSelectedId(undefined);
    if (history.current) history.current.scrollTop = 0;
    saveViewport(nextBranch, nextTurns);
  }

  function actions(item: CheckpointListItem) {
    const parentId = item.parentCheckpointId;
    return (
      <>
        <DropdownMenuItem
          onClick={() =>
            onRestore(
              item,
              Array.from(
                history.current?.querySelectorAll<HTMLButtonElement>("[data-checkpoint-id]") ?? [],
              ).find((row) => row.dataset.checkpointId === item.id),
            )
          }
          disabled={disabled}
        >
          <RotateCcw aria-hidden="true" />
          {copy.restoreNode}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onRename(item)} disabled={disabled || view.blocked}>
          <Pencil aria-hidden="true" />
          {copy.rename}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => copyText(item.id)}
          disabled={!globalThis.navigator?.clipboard}
        >
          <Copy aria-hidden="true" />
          {copy.copyId}
        </DropdownMenuItem>
        {parentId && positions.has(parentId) && (
          <DropdownMenuItem
            onClick={() => {
              setSelectedId(parentId);
              const row = history.current?.querySelector<HTMLButtonElement>(
                `[data-checkpoint-id="${CSS.escape(parentId)}"]`,
              );
              row?.scrollIntoView({ block: "nearest" });
              row?.focus({ preventScroll: true });
            }}
          >
            <ArrowUp aria-hidden="true" />
            {copy.navigateParent}
          </DropdownMenuItem>
        )}
        {allBranches.length > 1 && (
          <DropdownMenuItem
            onClick={() => changeFilter(item.branchId, showTurns)}
            disabled={branchFilter === item.branchId}
          >
            <GitBranch aria-hidden="true" />
            {copy.focusBranch}
          </DropdownMenuItem>
        )}
        {editableBranch(item.branchId) && (
          <DropdownMenuItem
            disabled={disabled || view.blocked}
            onClick={() => renameBranch(item.branchId)}
          >
            <Pencil aria-hidden="true" />
            {copy.renameBranch}
          </DropdownMenuItem>
        )}
      </>
    );
  }

  const contextItem = contextId ? positions.get(contextId)?.item : undefined;
  return (
    <div className="min-w-0 space-y-2">
      {(allBranches.length > 1 || hasTurns) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {allBranches.length > 1 && (
            <div className="flex min-w-0 max-w-full items-center gap-1">
              <OptionSelect
                aria-label={copy.branchFilter}
                className="min-w-0 max-w-full"
                value={branchFilter || "all"}
                onValueChange={(value) => changeFilter(value === "all" ? "" : value, showTurns)}
                options={[
                  { value: "all", label: copy.allBranches },
                  ...allBranches.map((id) => ({ value: id, label: branchLabel(id) })),
                ]}
              />
              {branchFilter && editableBranch(branchFilter) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={copy.renameBranch}
                  title={copy.renameBranch}
                  disabled={disabled || view.blocked}
                  onClick={() => renameBranch(branchFilter)}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
          {hasTurns && !onlyRecoveryTurns && (
            <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="size-3.5 shrink-0"
                checked={showTurns}
                onChange={(event) => changeFilter(branchFilter, event.target.checked)}
              />
              {copy.showTurns}
            </label>
          )}
        </div>
      )}
      {layout.nodes.length === 0 && (
        <p className="text-sm text-muted-foreground">{copy.emptyFiltered}</p>
      )}
      <section
        hidden={layout.nodes.length === 0}
        ref={history}
        aria-label={copy.tree}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users can scroll the history.
        tabIndex={0}
        className="max-h-[min(62vh,760px)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onScroll={() => saveViewport()}
      >
        <ContextMenu
          disabled={disabled}
          onOpenChange={(open, details) => {
            if (!open) return;
            const target = details.event.target;
            const id =
              target instanceof Element
                ? target.closest<HTMLButtonElement>("button[data-checkpoint-id]")?.dataset
                    .checkpointId
                : undefined;
            if (!id || !positions.has(id)) {
              details.cancel();
              return;
            }
            setContextId(id);
          }}
        >
          <ContextMenuTrigger data-testid="checkpoint-tree-canvas" className="relative @container">
            <div
              aria-hidden="true"
              data-testid="checkpoint-graph-gutter"
              className="pointer-events-none absolute inset-y-0 start-0 z-10"
              style={{ width: layout.width }}
            >
              <svg
                className="absolute top-0 max-w-none"
                width={layout.width}
                height={layout.height}
              >
                {layout.nodes.map((node) => {
                  const parent = node.item.parentCheckpointId
                    ? positions.get(node.item.parentCheckpointId)
                    : undefined;
                  if (!parent || node.reference) return null;
                  return (
                    <path
                      key={node.item.id}
                      data-checkpoint-edge={node.item.id}
                      d={edgePath(parent, node)}
                      fill="none"
                      stroke={node.color}
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                      opacity="0.55"
                    />
                  );
                })}
                {layout.nodes.map(({ item, x, y, color, reference }) => (
                  <g key={item.id}>
                    {item.id === view.currentCheckpointId && (
                      <circle cx={x} cy={y} r={7} fill="none" stroke={color} strokeWidth={2} />
                    )}
                    <circle
                      data-checkpoint-point={item.id}
                      data-checkpoint-reference={reference ? "" : undefined}
                      cx={x}
                      cy={y}
                      r={4.5}
                      fill={reference ? "var(--background)" : color}
                      stroke={reference ? color : "var(--background)"}
                      strokeWidth={reference ? 2 : 1}
                    />
                  </g>
                ))}
              </svg>
            </div>
            {layout.nodes.map(({ item }) => {
              const isCurrent = item.id === view.currentCheckpointId;
              const title = item.label || copy.kinds[item.kind];
              const preview = item.promptPreview?.replace(/\s+/g, " ").trim() || copy.noPrompt;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={disabled}
                  aria-label={`${copy.inspectNode} ${title}`}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-pressed={selectedId === item.id}
                  aria-haspopup="menu"
                  data-checkpoint-id={item.id}
                  onClick={() => setSelectedId(selectedId === item.id ? undefined : item.id)}
                  onKeyDown={(event) => {
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      event.currentTarget.dispatchEvent(
                        new MouseEvent("contextmenu", {
                          bubbles: true,
                          cancelable: true,
                          clientX: rect.left + 8,
                          clientY: rect.bottom,
                        }),
                      );
                    }
                  }}
                  className="flex w-full min-w-0 items-center border-b border-border/60 text-start transition-colors last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60 data-[selected=true]:bg-accent motion-reduce:transition-none"
                  data-selected={selectedId === item.id}
                  style={{ height: rowHeight }}
                >
                  <span aria-hidden="true" className="shrink-0" style={{ width: layout.width }} />
                  <span className="min-w-0 flex-1 space-y-0.5 pe-3">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
                      {isCurrent && (
                        <span className="hidden shrink-0 text-xs text-muted-foreground @min-[280px]:inline">
                          {copy.branchTip}
                        </span>
                      )}
                    </span>
                    <span className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate">{preview}</span>
                      <time
                        className="hidden shrink-0 whitespace-nowrap tabular-nums @min-[280px]:inline"
                        dateTime={item.createdAt}
                      >
                        {date(item.createdAt, locale)}
                      </time>
                    </span>
                  </span>
                </button>
              );
            })}
          </ContextMenuTrigger>
          <ContextMenuContent aria-label={copy.actions}>
            {contextItem && actions(contextItem)}
          </ContextMenuContent>
        </ContextMenu>
      </section>
      {copied && (
        <p role="status" className="text-xs text-muted-foreground">
          {copy.copiedId}
        </p>
      )}
      {selected && (
        <section aria-label={copy.details} className="min-w-0 border-t border-border pt-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">
                {selected.label || copy.kinds[selected.kind]}
              </h3>
              <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                <span>{branchLabel(selected.branchId)}</span>
                <time dateTime={selected.createdAt}>{date(selected.createdAt, locale)}</time>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button type="button" variant="ghost" size="icon-sm" />}
                  aria-label={copy.actions}
                  title={copy.actions}
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-56 max-w-(--available-width)"
                  aria-label={copy.actions}
                >
                  {actions(selected)}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={copy.closeDetails}
                title={copy.closeDetails}
                onClick={() => setSelectedId(undefined)}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
          {linkedParent && (
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              <span>
                {copy.linkedCheckpoint}: {linkedParent.label || copy.kinds[linkedParent.kind]}
              </span>
              <time dateTime={linkedParent.createdAt}>{date(linkedParent.createdAt, locale)}</time>
            </p>
          )}
          <p className="my-2 max-h-28 overflow-y-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
            {selected.promptPreview?.trim() || copy.noPrompt}
          </p>
        </section>
      )}
    </div>
  );
}
