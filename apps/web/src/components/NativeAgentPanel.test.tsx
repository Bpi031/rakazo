// @vitest-environment jsdom
import { NativeDecision } from "@rakazo/contracts";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createQueryRoot } from "../lib/query/query-root.test-support";

vi.mock("../lib/rpc", () => ({ withSpaceHeaders: (h = {}) => h }));

import { NativeAgentPanel } from "./NativeAgentPanel";

let root: ReturnType<typeof createQueryRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  const mounted = root;
  if (mounted) await act(async () => mounted.unmount());
  root = undefined;
  host?.remove();
  vi.unstubAllGlobals();
});
async function fixture(completed = true) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const calls: z.infer<typeof NativeDecision>[] = [];
  const preferences = { mode: "execute", persistence: true, action: "none", revision: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        if (typeof init.body !== "string") throw new Error("Expected a JSON decision");
        const body = NativeDecision.parse(JSON.parse(init.body));
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
  const mounted = createQueryRoot(host);
  root = mounted;
  await act(async () => mounted.render(<NativeAgentPanel botId="own-bot" />));
  return calls;
}
it("Plan changes only the next-turn preferences and is fenced against duplicate clicks", async () => {
  const calls = await fixture();
  const button = host.querySelector<HTMLInputElement>('input[type="radio"][value="plan"]')!;
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
  expect(calls[0]?.preferences.action).toBe("review");
  expect(calls).toHaveLength(1);
});
