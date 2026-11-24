import type { CheckpointListItem, CheckpointView } from "@rakazo/contracts";
import { botColors } from "@rakazo/ui-tokens";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@rakazo/ui-web";
import { useId, useMemo, useRef, useState } from "react";
import { useCheckpointI18n } from "../lib/checkpoint-i18n";

const laneWidth = 44;
const rowHeight = 48;
const date = (value: string, locale: string) =>
  new Date(value).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function checkpointTreeLayout(view: CheckpointView) {
  const byId = new Map(view.checkpoints.map((item) => [item.id, item]));
  const lineage = new Set<string>();
  let anchor = view.currentCheckpointId;
  while (anchor && !lineage.has(anchor)) {
    lineage.add(anchor);
    anchor = byId.get(anchor)?.parentCheckpointId ?? null;
  }
  const owner = (item: CheckpointListItem) =>
    lineage.has(item.id) && view.activeBranchId ? view.activeBranchId : item.branchId;
  const used = new Set(view.checkpoints.map(owner));
  const branches = view.branches.filter(
    (branch) => branch.id === view.activeBranchId || used.has(branch.id),
  );
  for (const item of view.checkpoints)
    if (!branches.some((branch) => branch.id === owner(item)))
      branches.push({ id: owner(item), parentCheckpointId: null, lastUsedAt: item.createdAt });
  if (view.activeBranchId && !branches.some((branch) => branch.id === view.activeBranchId))
    branches.push({
      id: view.activeBranchId,
      parentCheckpointId: view.currentCheckpointId,
      lastUsedAt: new Date().toISOString(),
    });
  branches.sort((a, b) =>
    a.id === view.activeBranchId
      ? -1
      : b.id === view.activeBranchId
        ? 1
        : b.lastUsedAt.localeCompare(a.lastUsedAt) || a.id.localeCompare(b.id),
  );
  const items = [...view.checkpoints].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  type PositionedNode = {
    item: CheckpointListItem;
    branchId: string;
    x: number;
    y: number;
    row: number;
  };
  const positioned = new Map<string, PositionedNode>();
  const nextLaneRow = new Map<string, number>();
  const visiting = new Set<string>();
  function place(item: CheckpointListItem): PositionedNode {
    const existing = positioned.get(item.id);
    if (existing) return existing;
    visiting.add(item.id);
    const parentItem = item.parentCheckpointId ? byId.get(item.parentCheckpointId) : undefined;
    const parent = parentItem && !visiting.has(parentItem.id) ? place(parentItem) : undefined;
    visiting.delete(item.id);
    const branchId = owner(item);
    const row = Math.max(parent ? parent.row + 1 : 0, nextLaneRow.get(branchId) ?? 0);
    const node = {
      item,
      branchId,
      row,
      x: 28 + branches.findIndex((branch) => branch.id === branchId) * laneWidth,
      y: 30 + row * rowHeight,
    };
    positioned.set(item.id, node);
    nextLaneRow.set(branchId, row + 1);
    return node;
  }
  const nodes = items.map(place);
  return {
    branches,
    nodes,
    width: Math.max(120, branches.length * laneWidth + 32),
    height: Math.max(240, ...nodes.map((node) => node.y + 42)),
  };
}

export function CheckpointTree({
  view,
  disabled,
  selectedId,
  onSelect,
}: {
  view: CheckpointView;
  disabled: boolean;
  selectedId?: string;
  onSelect: (item: CheckpointListItem) => void;
}) {
  const { copy, locale } = useCheckpointI18n();
  const tooltipId = useId();
  const layout = useMemo(() => checkpointTreeLayout(view), [view]);
  const branchColors = useMemo(
    () =>
      new Map(
        [
          ...new Set([
            ...view.branches.map((branch) => branch.id),
            ...layout.branches.map((branch) => branch.id),
          ]),
        ]
          .sort()
          .map((id, index) => [id, botColors[index % botColors.length]!]),
      ),
    [view.branches, layout.branches],
  );
  const colorFor = (id: string) => branchColors.get(id) ?? botColors[0];
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const positions = new Map(layout.nodes.map((node) => [node.item.id, node]));

  return (
    <TooltipProvider>
      <div className="overflow-hidden rounded-xl border border-border bg-muted/10">
        <section
          ref={viewport}
          aria-label={copy.tree}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus and scroll the tree viewport.
          tabIndex={0}
          className="relative overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{
            height: "clamp(360px, 62vh, 760px)",
            cursor: dragging ? "grabbing" : "grab",
            touchAction: "none",
            userSelect: "none",
            backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              left: event.currentTarget.scrollLeft,
              top: event.currentTarget.scrollTop,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setDragging(true);
            setHover(null);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
            event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
          }}
          onPointerUp={() => {
            drag.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onScroll={() => setHover(null)}
        >
          <div
            data-testid="checkpoint-tree-canvas"
            className="relative"
            style={{ width: layout.width, height: layout.height }}
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              width={layout.width}
              height={layout.height}
            >
              {layout.nodes.map((node) => {
                const parent = node.item.parentCheckpointId
                  ? positions.get(node.item.parentCheckpointId)
                  : undefined;
                if (!parent) return null;
                const bend = parent.y + Math.min(40, (node.y - parent.y) / 2);
                return (
                  <path
                    key={node.item.id}
                    d={`M ${parent.x} ${parent.y} C ${parent.x} ${bend}, ${node.x} ${bend}, ${node.x} ${node.y}`}
                    fill="none"
                    stroke={colorFor(node.branchId)}
                    strokeWidth="2"
                    opacity="0.55"
                  />
                );
              })}
            </svg>
            {layout.nodes.map(({ item, branchId, x, y }) => {
              const isCurrent = item.id === view.currentCheckpointId;
              const color = colorFor(branchId);
              return (
                <Tooltip
                  key={item.id}
                  open={hover === item.id}
                  onOpenChange={(open) => setHover(open ? item.id : null)}
                >
                  <TooltipTrigger
                    disabled={disabled}
                    render={<button type="button" disabled={disabled} />}
                    aria-label={`${copy.restoreNode} ${item.label || copy.kinds[item.kind]}`}
                    aria-describedby={hover === item.id ? `${tooltipId}-${item.id}` : undefined}
                    onClick={() => {
                      setHover(null);
                      onSelect(item);
                    }}
                    className="absolute cursor-pointer rounded-full border-2 border-background transition-shadow hover:ring-4 hover:ring-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60"
                    style={{
                      left: x - (isCurrent ? 9 : 8),
                      top: y - (isCurrent ? 9 : 8),
                      width: isCurrent ? 18 : 16,
                      height: isCurrent ? 18 : 16,
                      backgroundColor: color,
                      boxShadow:
                        selectedId === item.id || isCurrent
                          ? `0 0 0 3px color-mix(in srgb, ${color} 30%, transparent)`
                          : undefined,
                    }}
                  />
                  <TooltipContent
                    role="tooltip"
                    id={`${tooltipId}-${item.id}`}
                    side="bottom"
                    align="start"
                    sideOffset={10}
                    className="block w-70 max-w-[calc(100vw-24px)] p-4"
                  >
                    {item.label && (
                      <p className="mb-2 break-words text-sm font-semibold">{item.label}</p>
                    )}
                    <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {item.promptPreview
                        ? item.promptPreview.length > 180
                          ? `${item.promptPreview.slice(0, 180)}…`
                          : item.promptPreview
                        : copy.noPrompt}
                    </p>
                    {item.promptCreatedAt && (
                      <time
                        dateTime={item.promptCreatedAt}
                        className="mt-3 block text-xs tabular-nums opacity-70"
                      >
                        {date(item.promptCreatedAt, locale)}
                      </time>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </section>
      </div>
    </TooltipProvider>
  );
}
