import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers/helpers";

const view = {
  revision: "revision-2",
  generation: 2,
  blocked: false,
  activeBranchId: "branch-a",
  currentCheckpointId: "clean-a",
  branches: [
    { id: "branch-a", parentCheckpointId: null, lastUsedAt: "2026-11-16T01:00:00Z" },
    { id: "branch-b", parentCheckpointId: "clean-a", lastUsedAt: "2026-11-15T02:00:00Z" },
  ],
  checkpoints: [
    {
      id: "clean-a",
      label: "人员与基础规则已确认",
      kind: "manual",
      branchId: "branch-a",
      parentCheckpointId: "solve-a",
      createdAt: "2026-11-15T01:00:00Z",
      promptPreview: "请按十一月已确认的人员和休假规则安排，保持周末值班优先级。",
      promptCreatedAt: "2026-11-15T00:59:00Z",
    },
    {
      id: "solve-a",
      label: null,
      kind: "auto_pre_solve",
      branchId: "branch-a",
      parentCheckpointId: null,
      createdAt: "2026-11-15T00:55:00Z",
      promptPreview: "请先检查所有输入。",
      promptCreatedAt: "2026-11-15T00:54:00Z",
    },
    {
      id: "branch-b-1",
      label: "调整周末方案",
      kind: "manual",
      branchId: "branch-b",
      parentCheckpointId: "clean-a",
      createdAt: "2026-11-15T02:00:00Z",
      promptPreview: "尝试减少连续周末值班。",
      promptCreatedAt: "2026-11-15T01:59:00Z",
    },
  ],
};

test("checkpoint tree previews prompts and confirms recovery with retry", async ({
  page,
}, testInfo) => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/checkpoints**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: view });
    requests.push({ url: request.url(), body: request.postDataJSON() });
    if (requests.length === 1) {
      return route.fulfill({
        status: 500,
        json: { code: "CHECKPOINT_INTERNAL", error: "Private backend detail" },
      });
    }
    if (requests.length === 2) {
      return route.fulfill({
        status: 409,
        json: { code: "CHECKPOINT_STALE", error: "Workspace changed." },
      });
    }
    return route.fulfill({ json: { ok: true, generation: 3, branchId: "branch-b" } });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  await expect(
    page.getByRole("button", { name: "Restore checkpoint 人员与基础规则已确认" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "撤销上次回滚" })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore checkpoint 人员与基础规则已确认" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("保持周末值班优先级");
  await captureScreenshot(page, testInfo, "checkpoint-tree-preview");
  await page.getByRole("button", { name: "Restore checkpoint 人员与基础规则已确认" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Running tasks will stop");
  expect(requests).toHaveLength(0);
  await captureScreenshot(page, testInfo, "checkpoint-restore-confirmation");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The checkpoint operation failed");
  await expect(page.getByRole("alert")).not.toContainText("Private backend detail");
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Workspace changed");
  expect(requests).toHaveLength(2);
  expect(requests[0]?.body).toEqual({
    botId: "fixture-bot",
    checkpointId: "clean-a",
    expectedGeneration: 2,
    expectedRevision: view.revision,
  });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Restore checkpoint Pre-solve checkpoint", exact: true })
    .click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Restored");
  expect(requests[2]?.body.checkpointId).toBe("solve-a");
});

test("a revision update closes the old confirmation and requires a new selection", async ({
  page,
}) => {
  let generation = view.generation;
  const requests: number[] = [];
  await page.route("**/api/checkpoints**", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { ...view, generation, revision: `revision-${generation}` } });
    }
    requests.push(route.request().postDataJSON().expectedGeneration);
    return route.fulfill({ json: { ok: true, generation: 4, branchId: "other" } });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  const select = page.getByRole("button", { name: "Restore checkpoint 人员与基础规则已确认" });
  await select.click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  generation += 1;
  await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 7000 });
  expect(requests).toHaveLength(0);
  await expect(page.getByRole("alert")).toContainText("Workspace changed");
  await select.click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Restored");
  expect(requests).toEqual([generation]);
});

test("a save in another tab invalidates an already-open restore confirmation", async ({
  page,
  context,
}) => {
  let revision = view.revision;
  const restores: string[] = [];
  await context.route("**/api/checkpoints**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET") {
      // The first tab has not seen the new revision on its background poll yet.
      return route.fulfill({
        json: path.endsWith("/status") ? view : { ...view, revision },
      });
    }
    if (path === "/api/checkpoints") {
      revision = "saved-in-another-tab";
      return route.fulfill({ status: 201, json: { id: "new-snapshot" } });
    }
    const expected = route.request().postDataJSON().expectedRevision;
    restores.push(expected);
    if (expected !== revision)
      return route.fulfill({ status: 409, json: { code: "CHECKPOINT_STALE" } });
    return route.fulfill({ json: { ok: true, generation: 3, branchId: "new" } });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  const checkpoint = page.getByRole("button", {
    name: "Restore checkpoint 人员与基础规则已确认",
  });
  await checkpoint.click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  const second = await context.newPage();
  try {
    await second.goto("/e2e/fixtures/checkpoints.html");
    const saved = second.waitForResponse((response) => response.status() === 201);
    await second.getByRole("button", { name: "Set a checkpoint" }).click();
    await saved;
  } finally {
    await second.close();
  }
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Workspace changed");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await checkpoint.click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Restored");
  expect(restores).toEqual([view.revision, revision]);
});

test("a stale status disables restore even while the refreshed list is still loading", async ({
  page,
}) => {
  let changed = false;
  let finishList!: () => void;
  const delayedList = new Promise<void>((resolve) => {
    finishList = resolve;
  });
  let refreshStarted!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const restores: Array<{ expectedGeneration: number }> = [];
  await page.route("**/api/checkpoints**", async (route) => {
    if (route.request().method() === "POST") {
      restores.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, generation: 3, branchId: "new" } });
    }
    const response = {
      ...view,
      revision: changed ? "changed-with-same-generation" : view.revision,
    };
    if (changed && new URL(route.request().url()).pathname === "/api/checkpoints") {
      refreshStarted();
      await delayedList;
    }
    return route.fulfill({ json: response });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  const select = page.getByRole("button", { name: "Restore checkpoint 人员与基础规则已确认" });
  await select.click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  changed = true;
  try {
    await refreshing;
    await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 1500 });
    await expect(select).toBeDisabled();
    expect(restores).toHaveLength(0);
  } finally {
    finishList();
  }
  await select.click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Restored");
  expect(restores).toMatchObject([{ expectedGeneration: view.generation }]);
});

test("a late initial list cannot replace newer checkpoint history", async ({ page }) => {
  let releaseInitial!: () => void;
  const initial = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const updated = {
    ...view,
    revision: "revision-3",
    generation: 3,
    checkpoints: view.checkpoints.map((node) =>
      node.id === "clean-a" ? { ...node, label: "Current saved checkpoint" } : node,
    ),
  };
  let listReads = 0;
  const restores: Array<{ expectedGeneration: number }> = [];
  await page.route("**/api/checkpoints**", async (route) => {
    if (route.request().method() === "POST") {
      restores.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, generation: 4, branchId: "new" } });
    }
    if (new URL(route.request().url()).pathname === "/api/checkpoints/status")
      return route.fulfill({ json: updated });
    if (++listReads === 1) {
      await initial;
      return route.fulfill({ json: view, headers: { "x-fixture-read": "initial" } });
    }
    return route.fulfill({ json: updated });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  const current = page.getByRole("button", { name: "Restore checkpoint Current saved checkpoint" });
  try {
    await expect(current).toBeVisible({ timeout: 8000 });
  } finally {
    const oldResponse = page.waitForResponse(
      (response) => response.headers()["x-fixture-read"] === "initial",
    );
    releaseInitial();
    await (await oldResponse).finished();
  }
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(current).toBeVisible({ timeout: 1000 });
  await current.click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect.poll(() => restores).toMatchObject([{ expectedGeneration: updated.generation }]);
});

test("a manual save accepts a small receipt and refreshes the timeline", async ({ page }) => {
  const saves: unknown[] = [];
  await page.route("**/api/checkpoints**", (route) => {
    if (route.request().method() === "POST") {
      saves.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { id: "manual-ready" } });
    }
    const updated = saves.length
      ? {
          ...view,
          revision: "manual-ready",
          currentCheckpointId: "manual-ready",
          checkpoints: [
            {
              id: "manual-ready",
              kind: "manual",
              label: "Roster inputs ready",
              branchId: "branch-a",
              createdAt: "2026-11-16T01:05:00Z",
              parentCheckpointId: "clean-a",
              promptPreview: null,
              promptCreatedAt: null,
            },
            ...view.checkpoints,
          ],
        }
      : view;
    return route.fulfill({ json: updated });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  const name = page.getByRole("textbox", { name: "Checkpoint name" });
  await name.fill("Roster inputs ready");
  expect(saves).toHaveLength(0);
  await page.getByRole("button", { name: "Set a checkpoint", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore checkpoint Roster inputs ready" }),
  ).toBeVisible();
  await expect(name).toHaveValue("");
  expect(saves).toEqual([
    { botId: "fixture-bot", expectedGeneration: view.generation, label: "Roster inputs ready" },
  ]);
});

test("a saved checkpoint does not become a failed save when its list request fails", async ({
  page,
}) => {
  let saves = 0;
  let readable = false;
  await page.route("**/api/checkpoints**", (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      saves += 1;
      return route.fulfill({ status: 201, json: { id: "saved-while-offline" } });
    }
    if (!saves) return route.fulfill({ json: view });
    if (!readable)
      return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    return route.fulfill({ json: { ...view, revision: "saved-while-offline" } });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  const save = page.getByRole("button", { name: "Set a checkpoint", exact: true });
  await save.click();
  await expect(page.getByText("Checkpoint saved. The list has not refreshed yet.")).toBeVisible({
    timeout: 1800,
  });
  await expect(save).toBeDisabled();
  expect(saves).toBe(1);
  readable = true;
  await expect(save).toBeEnabled({ timeout: 6500 });
  expect(saves).toBe(1);
  await expect(page.getByText("Checkpoint saved. The list has not refreshed yet.")).toHaveCount(0);
});

for (const captureActive of [false, true]) {
  test(`losing ${captureActive ? "active" : "pending"} pointer capture ends a checkpoint graph drag`, async ({
    page,
  }) => {
    await page.goto("/e2e/fixtures/checkpoints.html?demo=branches");
    const tree = page.getByRole("region", { name: "Checkpoint tree, drag to pan" });
    await expect(tree).toBeVisible();
    const box = (await tree.boundingBox())!;
    await tree.evaluate((element) => {
      element.addEventListener(
        "pointerdown",
        (event) => {
          if (event instanceof PointerEvent) {
            element.dataset.testDragPointer = String(event.pointerId);
          }
        },
        { once: true },
      );
    });
    await page.mouse.move(box.x + box.width - 25, box.y + 70);
    await page.mouse.down();
    try {
      await expect(tree).toHaveCSS("cursor", "grabbing");
      if (captureActive) {
        await page.mouse.move(box.x + box.width - 26, box.y + 70);
        await expect(tree).toHaveCSS("cursor", "grabbing");
      }
      await tree.evaluate((element) =>
        element.releasePointerCapture(Number(element.dataset.testDragPointer)),
      );
      await page.mouse.move(box.x + box.width - 35, box.y + 65);
      await expect(tree).toHaveCSS("cursor", "grab", { timeout: 1500 });
    } finally {
      await page.mouse.up();
    }
  });
}

test("restore identifies the exact checkpoint and cannot silently change targets", async ({
  page,
}) => {
  const restored: string[] = [];
  await page.route("**/api/checkpoints**", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: view });
    restored.push(route.request().postDataJSON().checkpointId);
    return route.fulfill({ json: { ok: true, generation: 3, branchId: "new" } });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  const first = page.getByRole("button", { name: "Restore checkpoint 人员与基础规则已确认" });
  const other = page.getByRole("button", { name: "Restore checkpoint 调整周末方案" });
  await first.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("人员与基础规则已确认");
  await expect(dialog.locator("time")).toHaveAttribute("datetime", view.checkpoints[0]!.createdAt);
  await expect(other).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(first).toBeFocused();
  expect(restored).toHaveLength(0);
  await other.click();
  await expect(dialog).toContainText("调整周末方案");
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Restored");
  expect(restored).toEqual(["branch-b-1"]);
});

test("checkpoint copy follows Chinese and uses English for other locales", async ({
  page,
}, testInfo) => {
  const catalogWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Uncompiled message detected"))
      catalogWarnings.push(message.text());
  });
  await page.route("**/api/checkpoints**", (route) => route.fulfill({ json: view }));
  await page.goto("/e2e/fixtures/checkpoints.html?locale=zh-CN");
  await expect(page.getByRole("button", { name: "设置节点", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "节点名称" })).toHaveAttribute(
    "placeholder",
    "名称（可选）",
  );
  await captureScreenshot(page, testInfo, "checkpoint-chinese");
  await page.goto("/e2e/fixtures/checkpoints.html?locale=de");
  await expect(page.getByRole("button", { name: "Set a checkpoint", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Checkpoint name" })).toHaveAttribute(
    "placeholder",
    "Name (optional)",
  );
  expect(catalogWarnings).toEqual([]);
});
