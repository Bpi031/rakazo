// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../lib/rpc", () => ({ withSpaceHeaders: (headers = {}) => headers }));
import { AgentWorkbenchPanel } from "./AgentWorkbenchPanel";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});
const id = "a1afc5c5-78f2-4bb2-8530-a2d9d98bb411";
const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === name)!;
async function change(selector: string, value: string) {
  const el = host.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function fixture(initialTab = "goals", initialReview?: string) {
  const calls: any[] = [];
  const view = {
    goal: { objective: "Review draft", status: "active", revision: 0 },
    selectedSkill: null,
    skills: [
      {
        id: "a".repeat(64),
        name: "Office",
        description: "Installed skill",
        sha256: "b".repeat(64),
      },
    ],
    hooks: [{ name: "private-owner", version: 1, description: "Owned bot only" }],
    records: [
      {
        id,
        kind: "change",
        status: "draft",
        digest: "d".repeat(64),
        title: "workspace/policy.rost",
      },
    ],
  };
  const fetcher = vi.fn(async (raw: any, init: any) => {
    const url = new URL(String(raw), "https://app.test");
    if (url.pathname.endsWith("/view")) return Response.json(view);
    if (url.pathname.endsWith("/detail")) {
      expect(url.searchParams.get("id")).toBe(id);
      return Response.json({
        id,
        kind: "change",
        status: "draft",
        digest: "d".repeat(64),
        payload: {
          path: "workspace/policy.rost",
          before: "original",
          proposedText: "draft",
          sourceSha256: "e".repeat(64),
        },
      });
    }
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.operation === "goal") view.goal = { ...body.goal, revision: 1 };
    return Response.json(
      body.operation === "save_draft"
        ? { draftPath: "workspace/policy.review.rost" }
        : { ok: true },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <AgentWorkbenchPanel
        botId="b"
        initialTab={initialTab}
        initialReview={initialReview}
        onClose={() => {}}
      />,
    ),
  );
  return { calls, fetcher };
}
it("saves a user task goal without solve or policy authority", async () => {
  const f = await fixture();
  await change('textarea[aria-label="Task goal"]', "Verify exports");
  expect(f.calls).toHaveLength(0);
  await act(async () => button("Save goal").click());
  expect(f.calls).toEqual([
    {
      botId: "b",
      operation: "goal",
      revision: 0,
      goal: { objective: "Verify exports", status: "active" },
    },
  ]);
});
it("requires exact draft review and password, with no auto-application", async () => {
  const f = await fixture("changes", id);
  expect(host.textContent).toContain("Proposed separate draft");
  expect(button("Save reviewed draft").disabled).toBe(true);
  expect(f.calls).toHaveLength(0);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await change('input[type="password"]', "synthetic-password");
  await act(async () => button("Save reviewed draft").click());
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({
    operation: "save_draft",
    id,
    digest: "d".repeat(64),
    botId: "b",
  });
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
});
it("selects only installed skills for the next turn", async () => {
  const f = await fixture("skills");
  await act(async () => button("Next turn").click());
  expect(f.calls).toEqual([{ botId: "b", operation: "select_skill", id: "a".repeat(64) }]);
});
