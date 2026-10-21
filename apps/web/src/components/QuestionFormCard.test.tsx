// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionFormCard } from "./QuestionFormCard";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});
const form = {
  schema: "rakazo/question-form/v1" as const,
  fields: [
    {
      id: "kind",
      label: "Decision",
      type: "choice" as const,
      options: ["Review", "Keep"],
      required: true,
    },
    { id: "cost", label: "Cost", type: "number" as const, min: 0, max: 5, required: true },
    { id: "date", label: "Start date", type: "date" as const, required: true },
  ],
};
async function render(onAnswer: (s: string) => Promise<void>, value = form) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QuestionFormCard question="Review these facts" form={value} onAnswer={onAnswer} />,
    ),
  );
}
const button = (text: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === text)!;
async function change(selector: string, value: string) {
  const el = host.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("waits quietly with no defaults and accepts a deliberate zero", async () => {
  const onAnswer = vi.fn(async (_answer: string) => {});
  await render(onAnswer);
  expect(button("Continue").disabled).toBe(true);
  expect(onAnswer).not.toHaveBeenCalled();
  await change("select", "Keep");
  await change('input[type="number"]', "0");
  await change('input[type="date"]', "2026-11-01");
  await act(async () => button("Answer later").click());
  expect(onAnswer).not.toHaveBeenCalled();
  await act(async () => button("Answer questions").click());
  await act(async () => button("Continue").click());
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(JSON.parse(onAnswer.mock.calls[0]![0])).toEqual({
    schema: "rakazo/question-answer/v1",
    values: { kind: "Keep", cost: 0, date: "2026-11-01" },
  });
});
it("never treats a failed submission as answered", async () => {
  const answer = vi.fn(async () => {
    throw new Error("failed");
  });
  await render(answer, { ...form, fields: [form.fields[0]!] });
  await change("select", "Review");
  await act(async () => button("Continue").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("not confirmed");
  expect(host.textContent).not.toContain("Answered");
});
