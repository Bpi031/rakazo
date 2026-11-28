import { readFileSync } from "node:fs";
import { i18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { afterEach, expect, it, vi } from "vitest";
import { checkpointCopy, checkpointError, checkpointHttpError } from "./checkpoint-i18n";

async function activateChinese() {
  const catalog = await formatter().parse(
    readFileSync(
      new URL("../../../../packages/i18n/locales/zh-CN/messages.po", import.meta.url),
      "utf8",
    ),
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

it("uses plain fallback text without looking up missing messages in Lingui", () => {
  i18n.loadAndActivate({ locale: "zh-CN", messages: { "checkpoint.set": "保存检查点" } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(checkpointCopy().set).toBe("保存检查点");
    expect(checkpointCopy().kinds.auto_turn_boundary).toBe("Turn checkpoint");
    expect(checkpointCopy("en").kinds.auto_turn_boundary).toBe("Turn checkpoint");
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

it("distinguishes a stale copy, blocked recovery and internal failure", () => {
  i18n.activate("en");
  expect(checkpointHttpError("CHECKPOINT_STALE", "private")).toBe(checkpointCopy().stale);
  expect(checkpointHttpError("CHECKPOINT_RECOVERY_BLOCKED", "private")).toBe(
    checkpointCopy().blocked,
  );
  expect(checkpointHttpError("CHECKPOINT_INTERNAL", "Workspace changed")).toBe(
    checkpointCopy().internal,
  );
  expect(checkpointHttpError(undefined, "Workspace changed; refresh checkpoints")).toBe(
    checkpointCopy().stale,
  );
});
