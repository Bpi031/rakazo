// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryRoot } from "../lib/query/query-root.test-support";

vi.mock("../lib/query/rpc", () => ({
  rpc: {},
  selectedSpaceId: () => "selected-test-space",
  rpcForSpace: () => ({}),
  withSpaceHeaders: (headers: Record<string, string>) => ({
    ...headers,
    "x-rakazo-space-id": "space",
  }),
}));

import { checkpointNeedsReload } from "../lib/checkpoints";
import { CheckpointGenerationMonitor, CheckpointsPanel } from "./CheckpointsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createQueryRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  i18n.load("en", {});
  i18n.activate("en");
});
const view = {
  revision: "revision-3",
  generation: 3,
  blocked: false,
  activeBranchId: "branch",
  currentCheckpointId: "clean",
  branches: [{ id: "branch", parentCheckpointId: null, lastUsedAt: "2026-11-15T01:00:00Z" }],
  checkpoints: [
    {
      id: "clean",
      label: "人员已确认",
      kind: "manual",
      branchId: "branch",
      createdAt: "2026-11-15T01:00:00Z",
      parentCheckpointId: null,
      promptPreview: "请按已确认规则排班",
      promptCreatedAt: "2026-11-15T00:59:00Z",
    },
  ],
};
const checkpointSelector = '[aria-label="Inspect checkpoint 人员已确认"]';

async function chooseRestore() {
  await act(async () => {
    host
      .querySelector(checkpointSelector)!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    const action = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (element) => element.textContent === "Restore checkpoint",
    );
    expect(action).toBeDefined();
    action!.click();
  });
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === text,
  )!;
}
async function render(
  options: { blocked?: boolean; failure?: boolean; workspaceBusy?: boolean } = {},
) {
  const restored = vi.fn();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    init.method === "POST"
      ? options.failure
        ? Response.json({ error: "Workspace changed; refresh checkpoints" }, { status: 409 })
        : Response.json({ ok: true, generation: 4, branchId: "new" })
      : Response.json({ ...view, blocked: options.blocked ?? false }),
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createQueryRoot(host);
  await act(async () =>
    root!.render(
      <CheckpointsPanel botId="bot" workspaceBusy={options.workspaceBusy} onRestored={restored} />,
    ),
  );
  return { restored, fetcher };
}

it("requires a target confirmation and submits the current generation and revision", async () => {
  const { restored, fetcher } = await render();
  expect(host.querySelector(checkpointSelector)).toBeTruthy();
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(host.querySelector('[aria-label="Checkpoint name"]')).toBeTruthy();
  await chooseRestore();
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Running tasks will stop",
  );
  expect(fetcher.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(0);
  await act(async () => button("Restore").click());
  expect(fetcher).toHaveBeenCalledWith(
    "/api/checkpoints/clean/rollback",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        checkpointId: "clean",
        expectedGeneration: 3,
        expectedRevision: view.revision,
        botId: "bot",
      }),
      headers: expect.objectContaining({ "x-rakazo-space-id": "space" }),
    }),
  );
  expect(restored).toHaveBeenCalledTimes(1);
});

it("names an incomplete checkpoint error and lets the user choose a different one", async () => {
  const { fetcher, restored } = await render();
  fetcher.mockImplementation(async (_url: string, init: RequestInit) =>
    init.method === "POST"
      ? Response.json({ code: "CHECKPOINT_INCOMPLETE", error: "hidden details" }, { status: 409 })
      : Response.json(view),
  );
  const checkpoint = host.querySelector<HTMLButtonElement>(checkpointSelector)!;
  await chooseRestore();
  await act(async () => button("Restore").click());
  expect(host.textContent).toContain(
    "This checkpoint is missing saved data. Choose another checkpoint.",
  );
  expect(host.textContent).not.toContain("hidden details");
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(checkpoint.disabled).toBe(false);
  expect(restored).not.toHaveBeenCalled();
});

it("shows a branching tree without an Undo action", async () => {
  await render();
  expect(button("撤销上次回滚")).toBeUndefined();
  expect(host.querySelector('[aria-label="Checkpoint history"]')).toBeTruthy();
});

it("does not reload on a failed restore and refreshes stale state for retry", async () => {
  const { restored, fetcher } = await render({ failure: true });
  await chooseRestore();
  await act(async () => button("Restore").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Workspace changed");
  expect(restored).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.filter((call) => call[1].method === "GET")).toHaveLength(2);
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});

it("blocks saving an incomplete workspace while allowing recovery", async () => {
  await render({ blocked: true });
  expect(button("Set a checkpoint").disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>(checkpointSelector)!.disabled).toBe(false);
  expect(host.textContent).toContain("Workspace recovery is incomplete");
});

it("keeps a reopened panel disabled while a workspace operation is still running", async () => {
  await render({ workspaceBusy: true });
  expect(button("Set a checkpoint").disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>(checkpointSelector)!.disabled).toBe(true);
});

it("does not reload a different chat when an unmounted restore completes", async () => {
  const completion = deferred<Response>();
  const fetcher = vi.fn((_url: string, init: RequestInit) =>
    init.method === "POST" ? completion.promise : Promise.resolve(Response.json(view)),
  );
  vi.stubGlobal("fetch", fetcher);
  const restored = vi.fn();
  const busy = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createQueryRoot(host);
  await act(async () =>
    root!.render(<CheckpointsPanel botId="bot" onRestored={restored} onBusyChange={busy} />),
  );
  await chooseRestore();
  await act(async () => button("Restore").click());
  expect(busy).toHaveBeenLastCalledWith(true);
  await act(async () => root!.unmount());
  root = undefined;
  await act(async () =>
    completion.resolve(Response.json({ ok: true, generation: 4, branchId: "new" })),
  );
  expect(restored).not.toHaveBeenCalled();
  expect(busy).toHaveBeenLastCalledWith(false);
});

it("recovers from an initial load error when the next status poll succeeds", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async (url: string) =>
      Response.json(
        url.includes("/status") ? { generation: 3, blocked: false, revision: view.revision } : view,
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createQueryRoot(host);
  await act(async () => root!.render(<CheckpointsPanel botId="bot" />));
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button("Set a checkpoint").disabled).toBe(false);
});

it("ignores a failed initial load after status has already refreshed the timeline", async () => {
  vi.useFakeTimers();
  const initial = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockImplementation(async () => Response.json(view)),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createQueryRoot(host);
  await act(async () => root!.render(<CheckpointsPanel botId="bot" />));
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(button("Set a checkpoint").disabled).toBe(false);
  await act(async () => initial.reject(new Error("obsolete request failed")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button("Set a checkpoint").disabled).toBe(false);
});

it("saves using the displayed generation and reloads the timeline", async () => {
  const { fetcher } = await render();
  await act(async () => button("Set a checkpoint").click());
  expect(fetcher).toHaveBeenCalledWith(
    "/api/checkpoints",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedGeneration: 3, botId: "bot" }),
    }),
  );
  expect(fetcher.mock.calls.filter((call) => call[1].method === "GET")).toHaveLength(2);
});

it("retries only the list after an acknowledged save, even when status is unchanged", async () => {
  vi.useFakeTimers();
  const { fetcher } = await render();
  let failed = false;
  fetcher.mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === "POST") return Response.json({ id: "saved" }, { status: 201 });
    if (!url.includes("/status") && !failed) {
      failed = true;
      return Response.json({ error: "Temporary read failure" }, { status: 503 });
    }
    return Response.json(view);
  });
  await act(async () => button("Set a checkpoint").click());
  expect(host.textContent).toContain("Checkpoint saved. The list has not refreshed yet.");
  expect(button("Set a checkpoint").disabled).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(button("Set a checkpoint").disabled).toBe(false);
  expect(host.textContent).not.toContain("The list has not refreshed");
  expect(fetcher.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(1);
});

it("saves an optional checkpoint name", async () => {
  const { fetcher } = await render();
  const input = host.querySelector<HTMLInputElement>('[aria-label="Checkpoint name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "  Inputs reviewed  ",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Set a checkpoint").click());
  const request = fetcher.mock.calls.find((call) => call[1].method === "POST")!;
  expect(JSON.parse(request[1].body as string)).toMatchObject({ label: "Inputs reviewed" });
  expect(input.value).toBe("");
});

it("reloads another tab only after recovery completes", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(view))
    .mockResolvedValueOnce(Response.json({ ...view, generation: 4, blocked: true }))
    .mockResolvedValueOnce(Response.json({ ...view, generation: 4, blocked: false }));
  vi.stubGlobal("fetch", fetcher);
  const blocked = vi.fn();
  const reload = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createQueryRoot(host);
  await act(async () =>
    root!.render(
      <CheckpointGenerationMonitor botId="bot" onBlockedChange={blocked} onReload={reload} />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(blocked).toHaveBeenLastCalledWith(true);
  expect(reload).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.every((call) => call[0] === "/api/checkpoints/status?botId=bot")).toBe(
    true,
  );
});

it("polls cheap status and refreshes the tree only when its revision changes", async () => {
  vi.useFakeTimers();
  let revision = view.revision;
  const fetcher = vi.fn(async (url: string) =>
    Response.json(
      url.includes("/status") ? { generation: 3, blocked: false, revision } : { ...view, revision },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createQueryRoot(host);
  await act(async () => root!.render(<CheckpointsPanel botId="bot" />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(
    fetcher.mock.calls.filter((call) => call[0] === "/api/checkpoints?botId=bot"),
  ).toHaveLength(1);
  revision = "revision-4";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(
    fetcher.mock.calls.filter((call) => call[0] === "/api/checkpoints?botId=bot"),
  ).toHaveLength(2);
  expect(button("Refresh")).toBeUndefined();
  expect(button("Export audit")).toBeUndefined();
});

it("does not reload on an unchanged generation or an in-progress restore", () => {
  expect(checkpointNeedsReload(view, view)).toBe(false);
  expect(checkpointNeedsReload(view, { generation: 4, blocked: true })).toBe(false);
  expect(
    checkpointNeedsReload({ generation: 4, blocked: true }, { generation: 4, blocked: false }),
  ).toBe(true);
});

it("follows the active Rakazo locale and falls back to English outside Chinese", async () => {
  await render();
  expect(button("Set a checkpoint")).toBeTruthy();
  await act(async () => {
    i18n.load("zh-CN", {
      "checkpoint.set": "设置节点",
      "checkpoint.name": "节点名称",
      "checkpoint.namePlaceholder": "名称（可选）",
    });
    i18n.activate("zh-CN");
  });
  expect(button("设置节点")).toBeTruthy();
  expect(host.querySelector<HTMLInputElement>('[aria-label="节点名称"]')?.placeholder).toBe(
    "名称（可选）",
  );
  await act(async () => {
    i18n.load("de", {});
    i18n.activate("de");
  });
  expect(button("Set a checkpoint")).toBeTruthy();
  expect(host.querySelector<HTMLInputElement>('[aria-label="Checkpoint name"]')?.placeholder).toBe(
    "Name (optional)",
  );
});
