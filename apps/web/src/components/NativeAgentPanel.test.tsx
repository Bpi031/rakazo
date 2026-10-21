// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../lib/rpc", () => ({ withSpaceHeaders: (h = {}) => h }));
import { NativeAgentPanel } from "./NativeAgentPanel";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});
async function fixture(completed = true) {
  const calls: any[] = [];
  const preferences = { mode: "execute", persistence: true, action: "none", revision: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: any, init: any) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        calls.push(body);
        Object.assign(preferences, body.preferences, { revision: preferences.revision + 1 });
        return Response.json({ ok: true });
      }
      return Response.json({
        enabled: true,
        preferences: { ...preferences },
        records: completed
          ? [{ id: "n", kind: "native_session", status: "completed", payload: {} }]
          : [],
      });
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<NativeAgentPanel botId="own-bot" />));
  return calls;
}
it("Plan changes only the next-turn preferences and is fenced against duplicate clicks", async () => {
  const calls = await fixture();
  const button = host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[0]!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    operation: "native_settings",
    botId: "own-bot",
    revision: 0,
    preferences: { mode: "plan", action: "none" },
  });
  expect(host.textContent).toContain("No solve is started or changed");
});
it("requires a completed context for fork/compaction but not a new read-only review", async () => {
  const calls = await fixture(false);
  const buttons = Array.from(host.querySelectorAll("button"));
  expect(buttons.find((b) => b.textContent === "Fork conversation")!.disabled).toBe(true);
  expect(buttons.find((b) => b.textContent === "Compact context")!.disabled).toBe(true);
  await act(async () => buttons.find((b) => b.textContent === "Review workspace")!.click());
  expect(calls[0].preferences.action).toBe("review");
  expect(calls).toHaveLength(1);
});
