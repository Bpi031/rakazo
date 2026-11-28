import { expect, it } from "vitest";
import { hasAsciiControl, hasInvalidJsonbText } from "./managed-text.mjs";

it("rejects all C0 controls while preserving the existing layout and DEL options", () => {
  for (let code = 0; code < 32; code++) {
    const text = String.fromCharCode(code);
    expect(hasAsciiControl(text)).toBe(true);
    expect(hasAsciiControl(text, { allowLayout: true })).toBe(![9, 10, 13].includes(code));
  }
  expect(hasAsciiControl(String.fromCharCode(127))).toBe(false);
  expect(hasAsciiControl(String.fromCharCode(127), { includeDelete: true })).toBe(true);
});

it("rejects NUL and unpaired surrogates without discarding valid supplementary characters", () => {
  expect(hasInvalidJsonbText("\0")).toBe(true);
  expect(hasInvalidJsonbText(String.fromCharCode(0xd800))).toBe(true);
  expect(hasInvalidJsonbText(String.fromCharCode(0xdc00))).toBe(true);
  expect(hasInvalidJsonbText(String.fromCodePoint(0x1f680))).toBe(false);
  expect(hasInvalidJsonbText("a\n\tb")).toBe(false);
});
