// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "") }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({ ChatMarkdown: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../lib/rpc", () => ({ rpc: {} }));

import { AskCard, type AskBlock } from "./AskCard";
import { QuestionCard } from "./QuestionCard";

const actions = [
  { id: "choice-1", label: "Keep coverage (Recommended)" },
  { id: "choice-2", label: "Change the test quota" },
];
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

async function mount(onAnswer = vi.fn(async (_answer: string) => {}), block?: AskBlock) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(block
    ? <AskCard block={block} canAnswer onAnswer={onAnswer} />
    : <QuestionCard question="Which test quota should change?" actions={actions} onAnswer={onAnswer} />));
  const button = (label: string) => Array.from(container.querySelectorAll("button"))
    .find((node) => node.textContent?.trim() === label)!;
  const radios = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  return { container, onAnswer, button, radios };
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("QuestionCard", () => {
  it("ships readable fallback labels in every production catalog", () => {
    for (const locale of ["en", "de", "es", "fr", "hi", "ko", "pt-BR", "ru", "tr", "zh-CN"]) {
      const catalog = readFileSync(resolve("apps/web/src/locales", locale, "messages.po"), "utf8");
      for (const label of ["Question", "Answer later", "Answer question", "Choose an answer",
        "Your own response", "Or write your own response", "Recommended", "Sending..."]) {
        expect(catalog).toContain(`msgid "${label}"\nmsgstr "${label}"`);
      }
    }
  });

  it("starts with no default, even when a recommendation is offered", async () => {
    const { container, onAnswer, button, radios } = await mount();
    expect(radios().map((radio) => radio.checked)).toEqual([false, false]);
    expect(button("Continue").disabled).toBe(true);
    expect(container.textContent).toContain("Recommended");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("selection waits for explicit confirmation and sends the stable option id", async () => {
    const { onAnswer, button, radios } = await mount();
    await click(radios()[1]!);
    expect(onAnswer).not.toHaveBeenCalled();
    await click(button("Continue"));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("choice-2");
    expect(button("Answered").disabled).toBe(true);
  });

  it("accepts a custom answer and clears the radio choice", async () => {
    const { container, onAnswer, button, radios } = await mount();
    await click(radios()[0]!);
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "  Leave the test unchanged  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(radios().some((radio) => radio.checked)).toBe(false);
    await click(button("Continue"));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("Leave the test unchanged");
  });

  it("answer later and close only collapse, preserving an unsent selection", async () => {
    const { container, onAnswer, button, radios } = await mount();
    await click(radios()[1]!);
    await click(button("Answer later"));
    expect(container.querySelector("form")).toBeNull();
    expect(onAnswer).not.toHaveBeenCalled();
    await click(button("Answer question"));
    expect(radios()[1]!.checked).toBe(true);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Answer later"]')!);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("does not submit or nudge after an arbitrarily long wait", async () => {
    vi.useFakeTimers();
    const { container, onAnswer } = await mount();
    await act(async () => vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains an answer after transport failure and permits an explicit retry", async () => {
    const onAnswer = vi.fn(async (_answer: string) => {});
    onAnswer.mockRejectedValueOnce(new Error("Connection interrupted"));
    const { container, button, radios } = await mount(onAnswer);
    await click(radios()[0]!);
    await click(button("Continue"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection interrupted");
    expect(radios()[0]!.checked).toBe(true);
    await click(button("Continue"));
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it("prevents duplicate submissions while awaiting the server", async () => {
    let release!: () => void;
    const onAnswer = vi.fn((_answer: string) => new Promise<void>((resolve) => { release = resolve; }));
    const { container, button, radios } = await mount(onAnswer);
    await click(radios()[1]!);
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(button("Sending...").disabled).toBe(true);
    await act(async () => release());
    expect(button("Answered").disabled).toBe(true);
  });
});

describe("AskCard protected boundaries", () => {
  it("uses the question panel only for an active ordinary choice", async () => {
    const { container } = await mount(undefined, { kind: "ask", text: "Test question", actions, status: "pending" });
    expect(container.querySelector('[data-testid="choice-question-card"]')).not.toBeNull();
  });

  it.each([
    { approvalEffectId: "effect", actions: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }] },
    { input: "secret" as const, actions: undefined },
    { status: "answered" as const, answer: "choice-2", actions },
  ])("does not replace approval, secret or answered cards: %j", async (extra) => {
    const { container } = await mount(undefined, { kind: "ask", text: "Protected question", ...extra });
    expect(container.querySelector('[data-testid="choice-question-card"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });
});
