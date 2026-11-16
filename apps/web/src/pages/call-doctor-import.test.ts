import { expect, it } from "vitest";
import { CallDoctorImportError, parseCallDoctorCsv } from "./call-doctor-import";

it("downloads a template that can be imported without changing its column names", () => {
  const template = readFileSync(
    new URL("../../public/templates/call-doctors.csv", import.meta.url),
    "utf8",
  );
  expect(parseCallDoctorCsv(template)).toEqual([
    { code: "D001", name: "Example Doctor", email: "doctor@example.com", active: true },
  ]);
});

it("imports spreadsheet CSV quoting, BOM, CRLF and reordered columns", () => {
  expect(
    parseCallDoctorCsv('\uFEFFEmail,Staff ID,Name\r\nONE@example.test,D01,"Doctor, One"\r\n'),
  ).toEqual([{ code: "D01", name: "Doctor, One", email: "one@example.test", active: true }]);
  expect(
    parseCallDoctorCsv('Code,Name,Email\nD02,"Doctor ""Two""",two@example.test')[0]!.name,
  ).toBe('Doctor "Two"');
});

it("rejects duplicate identity and invalid rows before any update", () => {
  for (const rows of [
    "D01,One,one@example.test\nD01,Two,two@example.test",
    "D01,One,one@example.test\nD02,Two,ONE@example.test",
    "D01,One,not-an-email",
    "D01,One,one@example.test,extra",
    'D01,"One,one@example.test',
  ])
    expect(() => parseCallDoctorCsv(`Staff ID,Name,Email\n${rows}`)).toThrow(CallDoctorImportError);
});

it("requires named columns and at least one doctor", () => {
  expect(() => parseCallDoctorCsv("Name,Email\nOne,one@example.test")).toThrow("columns");
  expect(() => parseCallDoctorCsv("Code,Name,Email\n")).toThrow("empty");
  expect(() => parseCallDoctorCsv("")).toThrow("empty");
});

it("bounds bulk input by file size and the backend's doctor batch limit", () => {
  expect(() => parseCallDoctorCsv("x".repeat(512 * 1024 + 1))).toThrow("large");
  const rows = Array.from({ length: 1001 }, (_, i) => `D${i},Doctor ${i},doctor${i}@example.test`);
  expect(() => parseCallDoctorCsv(`Code,Name,Email\n${rows.join("\n")}`)).toThrow("large");
});

import { readFileSync } from "node:fs";
