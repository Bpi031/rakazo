// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../lib/rpc", () => ({
  withSpaceHeaders: (extra: any) => ({ ...extra, "x-rakazo-space-id": "s" }),
}));
import { TeamWorkflowsPanel } from "./TeamWorkflowsPanel";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  vi.unstubAllGlobals();
});
const item = {
  id: "f",
  digest: "d".repeat(64),
  name: "Department brief",
  status: "draft",
  manager: true,
  ready: false,
  leadBotId: "lead",
  expiresAt: "2099-01-01T00:00:00Z",
  reviewExpiresAt: "2099-01-01T00:00:00Z",
  definition: {
    name: "Department brief",
    leadBotId: "lead",
    objective: "Consolidate explicitly shared information",
    modelId: "approved",
    participants: [{ botId: "peer", instruction: "Summarize supplied facts" }],
    allowParticipantStart: true,
    maxStartsPerDay: 2,
    maxOutputTokens: 512,
    grantDays: 7,
  },
  participants: [
    { botId: "lead", name: "Lead", you: true, consented: false },
    { botId: "peer", name: "Department", you: false, consented: false },
  ],
  executions: [],
};
async function render(value: any[] = [item]) {
  const fetcher = vi.fn(async () => Response.json(value));
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<TeamWorkflowsPanel botId="lead" onClose={() => {}} />));
  return fetcher;
}
it("shows the reviewed scope without auto-enabling or requesting a password", async () => {
  const fetcher = await render();
  expect(host.textContent).toContain("Department brief");
  expect(host.textContent).toContain("No private files");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every((call: any) => call[1].method === "GET")).toBe(true);
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
it("shows a human grant review and disables confirmation until deliberately checked", async () => {
  const fetcher = await render();
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "Review and enable")!
      .click(),
  );
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(host.querySelector('input[type="password"]')?.getAttribute("autocomplete")).toBe(
    "current-password",
  );
  const confirm = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Confirm workflow decision",
  )!;
  expect(confirm.disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "Cancel")!
      .click(),
  );
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
it("ordinary recipients get only their consent controls, not manager controls", async () => {
  await render([
    {
      ...item,
      manager: false,
      leadBotId: "other",
      participants: [{ botId: "lead", name: "Member", you: true, consented: false }],
    },
  ]);
  expect(host.textContent).toContain("Review consent");
  expect(host.textContent).not.toContain("Review and enable");
});
it("does not render an unrelated bot's workflow", async () => {
  await render([
    { ...item, participants: [{ botId: "other", name: "Other", you: false, consented: false }] },
  ]);
  expect(host.textContent).not.toContain("Department brief");
});
it("shows approval-needed results without exposing an apply-policy or solve button", async () => {
  await render([
    {
      ...item,
      executions: [
        {
          id: "e",
          createdAt: "2026-10-21T00:00:00Z",
          status: "needs_approval",
          steps: [{ botId: "peer", status: "needs_approval", text: "Owner decision required" }],
        },
      ],
    },
  ]);
  expect(host.textContent).toContain("needs_approval");
  expect(host.textContent).toContain("Owner decision required");
  expect(host.querySelectorAll("button[data-solve]")).toHaveLength(0);
});
it("shows two-party leadership review without exposing private-data transfer controls", async () => {
  const handover = {
    id: "h",
    digest: "d".repeat(64),
    status: "offered",
    sender: false,
    fromBotId: "old",
    toBotId: "lead",
    fromName: "Current manager",
    toName: "Your own bot",
    sourceRemainsOwner: false,
    workflows: [],
    expiresAt: "2099-01-01T00:00:00Z",
  };
  const fetcher = vi.fn(async (url: any) =>
    Response.json(String(url).includes("team-leadership") ? [handover] : []),
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<TeamWorkflowsPanel botId="lead" onClose={() => {}} />));
  expect(host.textContent).toContain("Private bot histories, files and licenses stay separate");
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "Review acceptance")!
      .click(),
  );
  expect(host.querySelector('[aria-label="Confirm exact leadership handover"]')).not.toBeNull();
  expect(
    Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm leadership decision",
    )!.disabled,
  ).toBe(true);
  expect(fetcher.mock.calls.every((c: any) => c[1].method === "GET")).toBe(true);
});
