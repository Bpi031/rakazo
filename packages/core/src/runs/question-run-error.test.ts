import { expect, it } from "vitest";
import { normalizeRunError } from "./run-error.js";

it.each([
  "ROST_QUESTION_INPUT_INVALID: private details",
  JSON.stringify([1, 2].map(index => ({ origin: "string", code: "too_big", maximum: 200, inclusive: true, path: ["fields", index, "label"], message: "private payload" }))),
])("classifies a question failure separately and hides validator payloads", details => {
  const result = normalizeRunError(details);
  expect(result.summary).toBe("Rakazo could not display the question form. No answer was recorded.");
  expect(result.details).toContain("ROST_QUESTION_INPUT_INVALID");
  expect(result.details).not.toContain("private");
});

it("does not misclassify a provider's unrelated validation error", () => {
  const details = JSON.stringify([{ origin: "string", code: "too_big", maximum: 200, path: ["prompt"] }]);
  expect(normalizeRunError(details).summary).toBe("The model provider returned an error.");
});
