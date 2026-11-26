import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

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
  let fail = true;
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/checkpoints**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: view });
    requests.push({ url: request.url(), body: request.postDataJSON() });
    if (fail) {
      fail = false;
      return route.fulfill({
        status: 409,
        json: { error: "Workspace changed. Please try again." },
      });
    }
    return route.fulfill({ json: { ok: true, generation: 3, branchId: "branch-b" } });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  await expect(
    page.getByRole("button", { name: "Inspect checkpoint 人员与基础规则已确认" }),
  ).toContainText("保持周末值班优先级");
  await expect(page.getByRole("button", { name: "撤销上次回滚" })).toHaveCount(0);
  const node = page.getByRole("button", { name: "Inspect checkpoint 人员与基础规则已确认" });
  await node.hover();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await node.click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Checkpoint details" })).toContainText(
    "保持周末值班优先级",
  );
  await captureScreenshot(page, testInfo, "checkpoint-tree-preview");
  await node.click({ button: "right" });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Restore checkpoint" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("人员与基础规则已确认");
  await expect(page.getByRole("alertdialog")).toContainText("Running tasks will stop");
  expect(requests).toHaveLength(0);
  await captureScreenshot(page, testInfo, "checkpoint-restore-confirmation");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Workspace changed");
  expect(requests[0]?.body).toEqual({
    botId: "fixture-bot",
    checkpointId: "clean-a",
    expectedGeneration: 2,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect checkpoint Pre-solve checkpoint", exact: true })
    .press("Shift+F10");
  await page.getByRole("menuitem", { name: "Restore checkpoint" }).press("Enter");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Restored");
  expect(requests[1]?.body.checkpointId).toBe("solve-a");
});

test("checkpoint actions rename, navigate, and support the details menu without restoring", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let payload = view;
  const writes: unknown[] = [];
  await page.route("**/api/checkpoints**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: payload });
    expect(route.request().url()).toMatch(/\/clean-a\/rename$/);
    writes.push(route.request().postDataJSON());
    payload = {
      ...view,
      revision: "renamed",
      checkpoints: view.checkpoints.map((item) =>
        item.id === "clean-a" ? { ...item, label: "Reviewed November draft" } : item,
      ),
    };
    return route.fulfill({ json: { ok: true } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e/fixtures/checkpoints.html");
  const target = page.getByRole("button", { name: "Inspect checkpoint 人员与基础规则已确认" });
  await target.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Checkpoint actions" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Copy checkpoint ID" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("clean-a");
  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Go to previous checkpoint" }).click();
  await expect(page.getByRole("region", { name: "Checkpoint details" })).toContainText(
    "Pre-solve checkpoint",
  );
  await target.click();
  await page.getByRole("button", { name: "Checkpoint actions" }).click();
  await page.getByRole("menuitem", { name: "Rename checkpoint" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename checkpoint" });
  await dialog.getByRole("textbox").fill("Reviewed November draft");
  await dialog.getByRole("button", { name: "Save name" }).click();
  await expect(
    page.getByRole("button", { name: "Inspect checkpoint Reviewed November draft" }),
  ).toBeVisible();
  expect(writes).toEqual([
    {
      botId: "fixture-bot",
      checkpointId: "clean-a",
      label: "Reviewed November draft",
      expectedRevision: view.revision,
    },
  ]);
});

test("long histories keep original points and edges stable when a branch is appended", async ({
  page,
}) => {
  const more = Array.from({ length: 39 }, (_, index) => ({
    ...view.checkpoints[2]!,
    id: `extra-${index}`,
    label: `Draft ${index + 1}`,
    kind: index % 2 ? "auto_turn_boundary" : "manual",
    branchId: `branch-${Math.floor(index / 3)}`,
    createdAt: new Date(Date.UTC(2026, 10, 17, 0, index)).toISOString(),
    parentCheckpointId: index ? `extra-${index - 1}` : "branch-b-1",
  }));
  const history = { ...view, checkpoints: [...view.checkpoints, ...more] };
  let payload = history;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/checkpoints**", (route) => route.fulfill({ json: payload }));
  await page.goto("/e2e/fixtures/checkpoints.html");
  const canvas = page.getByTestId("checkpoint-tree-canvas");
  const points = canvas.locator("[data-checkpoint-point]");
  await expect(points).toHaveCount(23);
  const geometry = () =>
    canvas
      .locator("[data-checkpoint-point], [data-checkpoint-edge]")
      .evaluateAll((nodes) =>
        Object.fromEntries(
          nodes.map((node) => [
            node.hasAttribute("data-checkpoint-point")
              ? "point:" + node.getAttribute("data-checkpoint-point")
              : "edge:" + node.getAttribute("data-checkpoint-edge"),
            [node.getAttribute("cx"), node.getAttribute("cy"), node.getAttribute("d")],
          ]),
        ),
      );
  const before = await geometry();
  const last = more.at(-1)!;
  payload = {
    ...history,
    revision: "after-restore",
    activeBranchId: "restored",
    currentCheckpointId: "new",
    checkpoints: [
      ...history.checkpoints,
      {
        ...last,
        id: "new",
        branchId: "restored",
        parentCheckpointId: "clean-a",
        createdAt: new Date(Date.UTC(2026, 10, 18)).toISOString(),
      },
    ],
  };
  await expect(points).toHaveCount(24);
  const after = await geometry();
  for (const [key, coordinates] of Object.entries(before)) expect(after[key]).toEqual(coordinates);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole("checkbox", { name: "Show old chat checkpoints" }).check();
  await expect(points).toHaveCount(43);
  await page.getByRole("combobox", { name: "Filter by branch" }).selectOption("branch-b");
  await expect(points).toHaveCount(3);
});

test("names restored branches from their origin and can rename an empty current branch", async ({
  page,
}) => {
  const branch = {
    id: "just-restored",
    parentCheckpointId: "clean-a",
    lastUsedAt: "2026-11-16T01:02:00Z",
  };
  let payload = {
    ...view,
    branches: [...view.branches, { ...branch, label: null as string | null }],
    activeBranchId: branch.id,
  };
  await page.setViewportSize({ width: 320, height: 790 });
  await page.route("**/api/checkpoints**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: payload });
    expect(route.request().url()).toMatch(/\/branches\/just-restored\/rename$/);
    expect(route.request().postDataJSON()).toEqual({
      botId: "fixture-bot",
      branchId: branch.id,
      expectedRevision: view.revision,
      label: "Weekend coverage trial",
    });
    payload = {
      ...payload,
      revision: "named",
      branches: [...view.branches, { ...branch, label: "Weekend coverage trial" }],
    };
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/e2e/fixtures/checkpoints.html");
  const filter = page.getByRole("combobox", { name: "Filter by branch" });
  await expect(filter.locator('option[value="branch-a"]')).toHaveText("Original history");
  await expect(filter.locator('option[value="just-restored"]')).toHaveText(
    /From 人员与基础规则已确认 .*current/,
  );
  await filter.selectOption(branch.id);
  await expect(
    page.getByTestId("checkpoint-tree-canvas").locator("[data-checkpoint-point]"),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Rename branch" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename branch" });
  await dialog.getByRole("textbox", { name: "Branch name" }).fill("Weekend coverage trial");
  await dialog.getByRole("button", { name: "Save name" }).click();
  await expect(filter.locator('option[value="just-restored"]')).toHaveText(
    "Weekend coverage trial (current)",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("crowded forks fit at narrow and desktop widths without arrow paging", async ({
  page,
}, testInfo) => {
  const forks = Array.from({ length: 14 }, (_, index) => ({
    ...view.checkpoints[2]!,
    id: `fork-${index}`,
    label: `Independent draft ${index}`,
    branchId: `fork-branch-${index}`,
    parentCheckpointId: "clean-a",
    createdAt: new Date(Date.UTC(2026, 10, 17, 0, index)).toISOString(),
  }));
  await page.route("**/api/checkpoints**", (route) =>
    route.fulfill({
      json: {
        ...view,
        currentCheckpointId: "fork-13",
        checkpoints: [...view.checkpoints, ...forks],
      },
    }),
  );
  await page.goto("/e2e/fixtures/checkpoints.html");
  const gutter = page.getByTestId("checkpoint-graph-gutter");
  await expect(gutter.locator("[data-checkpoint-point]")).toHaveCount(17);
  await expect(
    gutter.locator('[data-checkpoint-reference][data-checkpoint-point="fork-13"]'),
  ).toHaveCount(1);
  await expect(gutter.locator('[data-checkpoint-edge="fork-13"]')).toHaveCount(0);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(
      await gutter.evaluate((element) => {
        const rail = element.getBoundingClientRect();
        return (
          rail.width <= 80 &&
          Array.from(element.querySelectorAll("circle")).every((circle) => {
            const point = circle.getBoundingClientRect();
            return point.left - 1 >= rail.left && point.right + 1 <= rail.right;
          })
        );
      }),
    ).toBe(true);
  }
  await expect(page.getByRole("button", { name: /branch lanes/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Inspect checkpoint Independent draft 13", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Checkpoint details" })).toContainText(
    "Previous checkpoint: 人员与基础规则已确认",
  );
  await page.getByRole("combobox", { name: "Filter by branch" }).selectOption("fork-branch-13");
  await expect(gutter.locator('[data-checkpoint-edge="fork-13"]')).toHaveCount(1);
  await captureScreenshot(page, testInfo, "checkpoint-focused-branch");
});

test("checkpoint copy follows Chinese and uses English for other locales", async ({
  page,
}, testInfo) => {
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
});
