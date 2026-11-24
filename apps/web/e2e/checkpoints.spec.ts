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
  await expect(page.getByRole("alert")).toContainText("Workspace changed");
  expect(requests[0]?.body).toEqual({
    botId: "fixture-bot",
    checkpointId: "clean-a",
    expectedGeneration: 2,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Restore checkpoint Pre-solve checkpoint", exact: true })
    .click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Restored");
  expect(requests[1]?.body.checkpointId).toBe("solve-a");
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
