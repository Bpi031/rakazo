// @vitest-environment jsdom

import type { CheckpointView } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CheckpointTree, checkpointTreeLayout, filterCheckpointTree } from "./CheckpointTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
});
const view: CheckpointView = {
  revision: "revision-1",
  generation: 1,
  blocked: false,
  activeBranchId: "active",
  currentCheckpointId: "a",
  branches: [
    { id: "old", parentCheckpointId: "a", lastUsedAt: "2026-11-15T01:00:00Z" },
    { id: "recent", parentCheckpointId: "a", lastUsedAt: "2026-11-16T01:00:00Z" },
    { id: "active", parentCheckpointId: null, lastUsedAt: "2026-11-14T01:00:00Z" },
    { id: "empty", parentCheckpointId: "a", lastUsedAt: "2026-11-16T02:00:00Z" },
  ],
  checkpoints: [
    {
      id: "a",
      label: "输入已确认",
      kind: "manual",
      branchId: "active",
      parentCheckpointId: null,
      createdAt: "2026-11-14T01:00:00Z",
      promptPreview: "请保留所有休假限制".repeat(30),
      promptCreatedAt: "2026-11-14T00:59:00Z",
    },
    {
      id: "b",
      label: "另一方案",
      kind: "manual",
      branchId: "old",
      parentCheckpointId: "a",
      createdAt: "2026-11-15T01:00:00Z",
      promptPreview: "尝试另一种安排",
      promptCreatedAt: "2026-11-15T00:59:00Z",
    },
    {
      id: "c",
      label: "最近方案",
      kind: "manual",
      branchId: "recent",
      parentCheckpointId: "a",
      createdAt: "2026-11-16T01:00:00Z",
      promptPreview: "保留最近方案",
      promptCreatedAt: "2026-11-16T00:59:00Z",
    },
  ],
};

it("separates overlapping forks and keeps branch order independent of lanes", () => {
  const layout = checkpointTreeLayout(view);
  expect(layout.branches).toEqual(["active", "old", "recent"]);
  expect(layout.nodes.map((node) => node.item.id)).toEqual(["a", "b", "c"]);
  expect(layout.nodes[0]!.x).toBeLessThan(layout.nodes[1]!.x);
  expect(layout.nodes[0]!.y).toBeLessThan(layout.nodes[1]!.y);
});

it("reuses columns for sequential forks without moving previously plotted checkpoints", () => {
  const base = view.checkpoints[0]!;
  const checkpoints = [
    base,
    ...Array.from({ length: 30 }, (_, index) => ({
      ...base,
      id: `chain-${index}`,
      branchId: `branch-${index}`,
      parentCheckpointId: index === 0 ? base.id : `chain-${index - 1}`,
      createdAt: new Date(Date.UTC(2026, 10, 17, 0, index)).toISOString(),
    })),
  ];
  const full = checkpointTreeLayout({ ...view, checkpoints });
  const early = checkpointTreeLayout({ ...view, checkpoints: checkpoints.slice(0, 10) });
  expect(full.nodes.slice(0, 10)).toEqual(early.nodes);
  expect(full.branches).toHaveLength(31);
  expect(new Set(full.nodes.map(({ x }) => x)).size).toBe(2);
  expect(full.nodes.some(({ reference }) => reference)).toBe(false);
});

it("caps simultaneous forks and never assigns a connector through existing lanes", () => {
  const base = view.checkpoints[0]!;
  const continuation = { ...base, id: "next", parentCheckpointId: base.id };
  const forks = Array.from({ length: 16 }, (_, index) => ({
    ...base,
    id: `fork-${index}`,
    branchId: `branch-${index}`,
    parentCheckpointId: base.id,
    createdAt: new Date(Date.UTC(2026, 10, 17, 0, index)).toISOString(),
  }));
  const layout = checkpointTreeLayout({ ...view, checkpoints: [base, continuation, ...forks] });
  expect(layout.nodes).toHaveLength(18);
  expect(layout.width).toBeLessThanOrEqual(80);
  expect(layout.nodes.filter(({ reference }) => reference)).toHaveLength(12);
  expect(layout.nodes.filter(({ reference }) => !reference).map(({ x }) => x)).toEqual([
    10, 10, 22, 34, 46, 58,
  ]);
});

it("keeps geometry independent of the active branch, selected tip, and last-used times", () => {
  const restored = checkpointTreeLayout({
    ...view,
    activeBranchId: "empty",
    currentCheckpointId: "b",
    branches: view.branches
      .toReversed()
      .map((branch) => ({ ...branch, lastUsedAt: "2026-11-30T01:00:00Z" })),
  });
  expect(restored).toEqual(checkpointTreeLayout(view));
});

it("appends a rescue and a new branch without changing existing points or their colors", () => {
  const before = checkpointTreeLayout(view);
  const restored = checkpointTreeLayout({
    ...view,
    activeBranchId: "resumed",
    checkpoints: [
      ...view.checkpoints,
      {
        ...view.checkpoints[2]!,
        id: "rescue",
        kind: "auto_pre_rollback",
        parentCheckpointId: "c",
        createdAt: "2026-11-18T01:00:00Z",
      },
      {
        ...view.checkpoints[0]!,
        id: "resumed",
        branchId: "resumed",
        parentCheckpointId: "a",
        createdAt: "2026-11-18T01:01:00Z",
      },
    ],
  });
  expect(restored.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
  expect(restored.branches).toEqual([...before.branches, "resumed"]);
});

it("gives siblings separate rows, even when timestamps match", () => {
  const layout = checkpointTreeLayout({
    ...view,
    checkpoints: [
      ...view.checkpoints,
      {
        ...view.checkpoints[1]!,
        id: "b2",
        createdAt: view.checkpoints[0]!.createdAt,
        parentCheckpointId: "b",
      },
    ],
  });
  const nodes = new Map(layout.nodes.map((node) => [node.item.id, node]));
  expect(new Set(layout.nodes.map((node) => node.y)).size).toBe(4);
  expect(nodes.get("b2")!.y).toBeGreaterThan(nodes.get("b")!.y);
  expect(nodes.get("b")!.y).toBeGreaterThan(nodes.get("a")!.y);
  expect(layout.height).toBe(224);
});

it("filters branches and reconnects saved checkpoints past legacy chat turns", () => {
  const legacy = {
    ...view.checkpoints[0]!,
    id: "legacy",
    label: null,
    parentCheckpointId: "a",
    kind: "auto_turn_boundary" as const,
  };
  const linked = {
    ...view,
    checkpoints: [
      ...view.checkpoints.map((node) =>
        node.id === "b" ? { ...node, parentCheckpointId: legacy.id } : node,
      ),
      legacy,
    ],
  };
  expect(
    filterCheckpointTree(linked, "old", false).checkpoints.map((node) => [
      node.id,
      node.parentCheckpointId,
    ]),
  ).toEqual([
    ["a", null],
    ["b", "a"],
  ]);
  expect(filterCheckpointTree(linked, "old", true).checkpoints.map((node) => node.id)).toEqual([
    "a",
    "b",
    "legacy",
  ]);
});

it("uses left click for details and right click or Shift+F10 for the actions menu", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const restore = vi.fn();
  await act(async () =>
    root!.render(
      <CheckpointTree view={view} disabled={false} onRestore={restore} onRename={vi.fn()} />,
    ),
  );
  const button = host.querySelector<HTMLButtonElement>(
    '[aria-label="Inspect checkpoint 输入已确认"]',
  )!;
  expect(button.textContent).toContain("输入已确认");
  expect(button.textContent).toContain("请保留所有休假限制");
  expect(button.textContent).toContain("Branch tip");
  expect(button.getAttribute("aria-current")).toBe("true");
  expect(button.querySelector("time")?.dateTime).toBe("2026-11-14T01:00:00Z");
  expect(button.style.height).toBe("56px");
  await act(async () => button.focus());
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => button.click());
  expect(restore).not.toHaveBeenCalled();
  const details = host.querySelector('[aria-label="Checkpoint details"]');
  expect(details?.textContent).toContain(view.checkpoints[0]!.promptPreview);
  expect(details?.querySelector("time")?.dateTime).toBe("2026-11-14T01:00:00Z");
  await act(async () =>
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(restore).not.toHaveBeenCalled();
  await act(async () => (document.querySelector('[role="menuitem"]') as HTMLElement).click());
  expect(restore).toHaveBeenLastCalledWith(view.checkpoints[0]);
  await act(async () =>
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
    ),
  );
  expect(document.querySelector('[role="menu"]')).toBeTruthy();
  expect(restore).toHaveBeenCalledTimes(1);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Close checkpoint details"]')!.click(),
  );
  expect(host.querySelector('[aria-label="Checkpoint details"]')).toBeNull();
  expect(host.querySelector('section[aria-label="Checkpoint history"]')).not.toBeNull();
  expect(host.querySelectorAll('[data-testid="checkpoint-tree-canvas"] button')).toHaveLength(
    view.checkpoints.length,
  );
});

it("gives an unnamed checkpoint a readable type and an honest empty preview", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const checkpoint = {
    ...view.checkpoints[0]!,
    label: null,
    kind: "auto_pre_solve" as const,
    promptPreview: null,
  };
  await act(async () =>
    root!.render(
      <CheckpointTree
        view={{ ...view, checkpoints: [checkpoint] }}
        disabled={true}
        onRename={vi.fn()}
        onRestore={vi.fn()}
      />,
    ),
  );
  const button = host.querySelector<HTMLButtonElement>(
    '[aria-label="Inspect checkpoint Pre-solve checkpoint"]',
  )!;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("No user message at this checkpoint.");
});
