import { describe, expect, it } from "vitest";
import { normalizeRunError } from "./run-error.js";

describe("usage accounting errors", () => {
  it.each([
    "ROST_USAGE_RECORD_FAILED: database unavailable",
    "\nInvalid `prisma.usageRecord.createMany()` invocation:\n{data:[{userId:'private-user',provider:undefined,model:undefined}]}\nArgument `provider` is missing.",
    "Invalid `prisma.usageRecord.create()` invocation:\nconnection secret placeholder",
    "Invalid `prisma.usageRecord.createMany()` invocation:\nmodel:openai cost limit timeout",
  ])("classifies usage persistence before provider heuristics and hides raw payloads", (details) => {
    const result = normalizeRunError(details);
    expect(result.summary).toBe("Rakazo could not save model usage. Check existing work before retrying.");
    expect(result.details).toContain("ROST_USAGE_RECORD_FAILED");
    expect(result.details).not.toContain("private-user");
    expect(result.details).not.toContain("placeholder");
    expect(result.details).not.toContain("data:");
  });

  it("does not change real provider errors", () => {
    const details = '401: {"message":"Incorrect API key: https://api.openai.com"}';
    expect(normalizeRunError(details).summary).toBe("Your OpenAI rejected the API key. Check your connection settings.");
  });

  it("passes the application summary through translation", () => {
    expect(normalizeRunError("ROST_USAGE_RECORD_FAILED:", (text) => `translated:${text}`).summary)
      .toBe("translated:Rakazo could not save model usage. Check existing work before retrying.");
  });
});
