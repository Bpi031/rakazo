import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCompiledCatalog, extractFromFileWithBabel } from "@lingui/cli/api";
import type { ExtractedMessage } from "@lingui/conf";
import { getConfig } from "@lingui/conf";
import { setupI18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

it("compiled production catalogs resolve every Call requests message and its placeholders", async () => {
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  const linguiConfig = getConfig({ cwd });
  const messages = new Map<string, ExtractedMessage>();
  for (const page of ["CallRequests.tsx", "CallDoctorDirectory.tsx"]) {
    const filename = fileURLToPath(new URL(`../pages/${page}`, import.meta.url));
    await extractFromFileWithBabel(
      filename,
      readFileSync(filename, "utf8"),
      (message) => messages.set(message.id, message),
      { linguiConfig },
      { plugins: ["typescript", "jsx"] },
    );
  }
  expect([...messages.values()].map((message) => message.message)).toEqual(
    expect.arrayContaining([
      "Call requests",
      "Staff ID",
      "Manage doctors",
      "More actions",
      "Template",
    ]),
  );
  const parse = formatter({ lineNumbers: false }).parse;
  for (const locale of linguiConfig.locales) {
    const catalogPath = fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url));
    const catalog = await parse(readFileSync(catalogPath, "utf8"), {
      locale,
      sourceLocale: "en",
      filename: catalogPath,
    });
    const translated: Record<string, string> = {};
    for (const message of messages.values()) {
      const entry = catalog[message.id];
      expect(entry?.translation, `${locale}: ${message.message}`).toBeTruthy();
      translated[message.id] = entry!.translation!;
    }
    const compiled = createCompiledCatalog(locale, translated, { namespace: "json" });
    expect(compiled.errors, locale).toEqual([]);
    const i18n = setupI18n({
      locale,
      messages: { [locale]: JSON.parse(compiled.source).messages },
    });
    for (const message of messages.values()) {
      const rendered = i18n._(message.id, { 0: "Doctor One", 1: "2026-11-04" });
      expect(rendered, `${locale}: ${message.message}`).toBeTruthy();
      expect(rendered, `${locale}: ${message.message}`).not.toBe(message.id);
    }
    const title = [...messages.values()].find((message) => message.message === "Call requests")!;
    expect(i18n._(title.id), locale).toBe(locale === "zh-CN" ? "值班请求" : "Call requests");
    const staffId = [...messages.values()].find((message) => message.message === "Staff ID")!;
    expect(i18n._(staffId.id), locale).toBe(locale === "zh-CN" ? "医生编号" : "Staff ID");
    const template = [...messages.values()].find((message) => message.message === "Template")!;
    expect(i18n._(template.id), locale).toBe(locale === "zh-CN" ? "模板" : "Template");
    const removal = [...messages.values()].find(
      (message) => message.message === "Delete request from {0} for {1}",
    )!;
    expect(i18n._(removal.id, { 0: "Doctor One", 1: "2026-11-04" })).toContain("Doctor One");
    expect(i18n._(removal.id, { 0: "Doctor One", 1: "2026-11-04" })).toContain("2026-11-04");
  }
});
