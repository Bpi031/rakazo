// @vitest-environment jsdom

import type { CheckpointView } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CheckpointTree, checkpointTreeLayout } from "./CheckpointTree";

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

it("places the active branch first and older branches further right without changing fixed geometry", () => {
  const layout = checkpointTreeLayout(view);
  expect(layout.branches.map((item) => item.id)).toEqual(["active", "recent", "old"]);
  expect(layout.nodes[0]!.x).toBeLessThan(layout.nodes[1]!.x);
  expect(layout.nodes[0]!.y).toBeLessThan(layout.nodes[1]!.y);
});

it("keeps a restored historical anchor in the active leftmost lane", () => {
  const layout = checkpointTreeLayout({ ...view, activeBranchId: "empty" });
  expect(layout.branches[0]!.id).toBe("empty");
  expect(layout.nodes.find((node) => node.item.id === "a")!.x).toBe(28);
  expect(layout.branches.some((branch) => branch.id === "active")).toBe(false);
});

it("shares depth rows across sibling branches and reserves space only within a lane", () => {
  const layout = checkpointTreeLayout({
    ...view,
    checkpoints: [
      ...view.checkpoints,
      { ...view.checkpoints[1]!, id: "b2", createdAt: "2026-11-17T01:00:00Z" },
    ],
  });
  const nodes = new Map(layout.nodes.map((node) => [node.item.id, node]));
  expect(nodes.get("b")!.y).toBe(nodes.get("c")!.y);
  expect(nodes.get("b")!.y - nodes.get("a")!.y).toBe(48);
  expect(nodes.get("b2")!.y - nodes.get("b")!.y).toBe(48);
  expect(layout.height).toBe(240);
});

it("previews the node prompt on focus and supports dragging the fixed canvas", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const select = vi.fn();
  await act(async () =>
    root!.render(<CheckpointTree view={view} disabled={false} onSelect={select} />),
  );
  const button = host.querySelector<HTMLButtonElement>(
    '[aria-label="Restore checkpoint 输入已确认"]',
  )!;
  expect(button.textContent).toBe("");
  expect(host.textContent).toBe("");
  expect(host.querySelector("time")).toBeNull();
  expect(button.style.width).toBe("18px");
  expect(
    host.querySelector<HTMLElement>('[data-testid="checkpoint-tree-canvas"]')!.style.width,
  ).toBe("164px");
  await act(async () => button.focus());
  await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeTruthy());
  const tooltip = document.querySelector('[role="tooltip"]')!;
  expect(tooltip.textContent).toContain("请保留所有休假限制");
  expect(tooltip.firstElementChild?.textContent).toBe("输入已确认");
  expect(tooltip.textContent).not.toContain("User prompt");
  expect(tooltip.textContent).toContain("…");
  expect(tooltip.querySelector("time")?.dateTime).toBe("2026-11-14T00:59:00Z");
  await act(async () => button.click());
  expect(select).toHaveBeenCalledWith(view.checkpoints[0]);
  const viewport = host.querySelector<HTMLElement>(
    'section[aria-label="Checkpoint tree, drag to pan"]',
  )!;
  const width = host.querySelector<HTMLElement>('[data-testid="checkpoint-tree-canvas"]')!.style
    .width;
  await act(async () =>
    viewport.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 100 }),
    ),
  );
  await act(async () =>
    viewport.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 50 }),
    ),
  );
  expect(viewport.scrollLeft).toBe(100);
  expect(viewport.scrollTop).toBe(50);
  expect(viewport.style.cursor).toBe("grabbing");
  expect(
    host.querySelector<HTMLElement>('[data-testid="checkpoint-tree-canvas"]')!.style.width,
  ).toBe(width);
  await act(async () => viewport.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
  expect(viewport.style.cursor).toBe("grab");
  expect(host.querySelector('[aria-label="当前工作区"]')).toBeNull();
  expect(host.querySelectorAll('[data-testid="checkpoint-tree-canvas"] button')).toHaveLength(
    view.checkpoints.length,
  );
});
