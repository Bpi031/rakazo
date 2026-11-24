import { readFileSync } from "node:fs";
import { i18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { afterEach, expect, it } from "vitest";
import { checkpointCopy, checkpointError } from "./checkpoint-i18n";

async function activateChinese() {
  const catalog = await formatter().parse(
    readFileSync(new URL("../locales/zh-CN/messages.po", import.meta.url), "utf8"),
    { locale: "zh-CN", sourceLocale: "en", filename: "messages.po" },
  );
  i18n.load(
    "zh-CN",
    Object.fromEntries(
      Object.entries(catalog).map(([id, value]) => [id, value.translation ?? value.message ?? id]),
    ),
  );
  i18n.activate("zh-CN");
}

afterEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

it("uses the Chinese catalog or the English fallback for checkpoint copy", async () => {
  await activateChinese();
  expect(checkpointCopy().set).toBe("设置节点");
  for (const locale of ["en", "zh-TW", "de", "fr", "ko", "tr", "hi", "pt-BR", "es", "ru"])
    expect(checkpointCopy(locale).set).toBe("Set a checkpoint");
});

it("localizes backend recovery and stale errors using the active locale", async () => {
  await activateChinese();
  expect(
    checkpointError("Recovery failed. Workspace is blocked; retry a saved checkpoint."),
  ).toContain("恢复未完成");
  expect(checkpointError("Workspace changed; refresh checkpoints")).toBe("工作区已变更，请重试。");
  expect(checkpointError("Internal database or filesystem details")).toBe(
    "节点操作未完成，请重试。",
  );
  expect(checkpointError("Workspace changed; refresh checkpoints", "de")).toBe(
    "Workspace changed. Please try again.",
  );
});

it("refreshes copy when the same locale receives an updated catalog", async () => {
  await activateChinese();
  expect(checkpointCopy().set).toBe("设置节点");
  i18n.load("zh-CN", { "checkpoint.set": "保存检查点" });
  expect(checkpointCopy().set).toBe("保存检查点");
});
