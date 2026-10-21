// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
i18n.load("en", {}); i18n.activate("en");
const mocks=vi.hoisted(() => ({list:vi.fn(),update:vi.fn()}));
vi.mock("../lib/rpc",() => ({rpc:{models:{list:mocks.list},bots:{update:mocks.update}}}));
import { ManagedModelPicker } from "./ManagedModelPicker";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it("offers only approved models, updates this bot and never starts a run",async () => {
  mocks.list.mockResolvedValue([{id:"approved",label:"Approved model"}]); mocks.update.mockResolvedValue({id:"b",modelId:"approved"});
  const el=document.createElement("div");document.body.append(el);const root=createRoot(el);const onChange=vi.fn();
  try {
    await act(async () => root.render(<ManagedModelPicker bot={{id:"b",modelId:null} as any} onChange={onChange}/>));
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')!.click());
    expect(el.textContent).toContain("Approved model");expect(el.querySelector('input[type="password"]')).toBeNull();
    expect(el.querySelector('[role="dialog"]')?.className).toContain("calc(100vw-7rem)");
    await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Approved model")!.click());
    expect(mocks.update).toHaveBeenCalledWith({botId:"b",modelProvider:"codex-foundry",modelId:"approved",thinkingLevel:null});expect(onChange).toHaveBeenCalledWith(expect.objectContaining({id:"b"}));
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  } finally {await act(async () => root.unmount());el.remove();}
});
it("shows only the current model's configured efforts and saves them for the next turn", async () => {
  mocks.list.mockResolvedValue([{ id: "flash", label: "Flash", thinkingLevels: ["low", "high", "max"], defaultThinkingLevel: "high" }]);
  mocks.update.mockResolvedValue({ id: "b", modelId: "flash", thinkingLevel: "max" });
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  try {
    await act(async () => root.render(<ManagedModelPicker bot={{ id: "b", modelId: "flash", thinkingLevel: null } as any} onChange={vi.fn()} />));
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')!.click());
    const group = el.querySelector('[aria-label="Reasoning effort"]')!;
    expect([...group.querySelectorAll('[role="radio"]')].map((e) => e.textContent)).toEqual(["Default · High", "Low", "High", "Max"]);
    await act(async () => [...group.querySelectorAll<HTMLButtonElement>('button')].find((e) => e.textContent === "Max")!.click());
    expect(mocks.update).toHaveBeenLastCalledWith({ botId: "b", modelProvider: "codex-foundry", modelId: "flash", thinkingLevel: "max" });
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); el.remove(); }
});
it("uses route-specific GPT efforts without borrowing DeepSeek Max or inventing Ultra", async () => {
  mocks.list.mockResolvedValue([
    { id: "sol", label: "GPT", thinkingLevels: ["low", "medium", "high", "xhigh"], defaultThinkingLevel: "low" },
    { id: "flash", label: "Flash", thinkingLevels: ["low", "high", "max"], defaultThinkingLevel: "low" },
  ]);
  mocks.update.mockResolvedValue({ id: "b", modelId: "sol", thinkingLevel: "xhigh" });
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  try {
    await act(async () => root.render(<ManagedModelPicker bot={{ id: "b", modelId: "sol", thinkingLevel: "low" } as any} onChange={vi.fn()} />));
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')!.click());
    const group = el.querySelector('[aria-label="Reasoning effort"]')!;
    expect([...group.querySelectorAll('[role="radio"]')].map((e) => e.textContent)).toEqual(["Default · Low", "Low", "Medium", "High", "Extra high"]);
    expect(group.textContent).not.toContain("Max"); expect(group.textContent).not.toContain("Ultra");
    await act(async () => [...group.querySelectorAll<HTMLButtonElement>('button')].find((e) => e.textContent === "Extra high")!.click());
    expect(mocks.update).toHaveBeenLastCalledWith({ botId: "b", modelProvider: "codex-foundry", modelId: "sol", thinkingLevel: "xhigh" });
  } finally { await act(async () => root.unmount()); el.remove(); }
});
