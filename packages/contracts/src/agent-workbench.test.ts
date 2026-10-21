import { expect, it } from "vitest";
import { QuestionForm, validateQuestionAnswer, WorkbenchBrowserInput, WorkbenchToolInput, WorkspacePath } from "./agent-workbench.js";
const form = QuestionForm.parse({ schema: "rakazo/question-form/v1", fields: [
  { id: "priority", label: "Preference", type: "choice", options: ["Review", "Keep"] },
  { id: "weight", label: "Weight", type: "number", min: 1, max: 20 },
  { id: "date", label: "Date", type: "date" },
] });
it("accepts exact typed values, including legitimate zero when permitted", () => {
  const answer = { schema: "rakazo/question-answer/v1", values: { priority: "Review", weight: 3, date: "2026-11-01" } };
  expect(JSON.parse(validateQuestionAnswer(form, JSON.stringify(answer)))).toEqual(answer);
});
it.each([
  {}, { priority: "Review", weight: "3", date: "2026-11-01" },
  { priority: "Other", weight: 3, date: "2026-11-01" }, { priority: "Keep", weight: 21, date: "2026-11-01" },
  { priority: "Keep", weight: 3, date: "2026-02-30" }, { priority: "Keep", weight: 3, date: "2026-11-01", approve_policy: "yes" },
])("rejects missing, forged and out-of-bound answers %j", (values) => {
  expect(() => validateQuestionAnswer(form, JSON.stringify({ schema: "rakazo/question-answer/v1", values }))).toThrow();
});
it.each(["/etc/passwd", "workspace/../x.rost", "workspace/.env", "workspace/a\\b", "workspace/a\u0000b", "workspace//x"])("rejects unsafe workspace path %s", (path) => expect(WorkspacePath.safeParse(path).success).toBe(false));
it("keeps sensitive mutations out of the agent tool schema", () => {
  for (const operation of ["save_draft", "approve", "solve", "select_skill", "goal"])
    expect(WorkbenchToolInput.safeParse({ operation }).success).toBe(false);
  expect(WorkbenchBrowserInput.safeParse({ operation: "goal", botId: "b", revision: 0, goal: { objective: "Plan", status: "active" }, userId: "other" }).success).toBe(false);
});
it("rejects ambiguous, secret and duplicated fields", () => {
  expect(QuestionForm.safeParse({ ...form, fields: [form.fields[0], form.fields[0]] }).success).toBe(false);
  expect(QuestionForm.safeParse({ ...form, fields: [{ id: "password", label: "Password", type: "password" }] }).success).toBe(false);
  expect(QuestionForm.safeParse({ ...form, fields: [{ id: "x", label: "X", type: "text", options: ["a", "b"] }] }).success).toBe(false);
});
