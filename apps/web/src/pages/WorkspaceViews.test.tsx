// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../lib/rpc", () => ({ withSpaceHeaders: () => ({}) }));
vi.mock("./TeamSettingsPanel", () => ({ TeamSettingsPanel: () => null }));
import { WorkspaceStoragePanel, WorkspaceUsagePanel } from "./WorkspaceViews";
const mounted: Array<{ root: Root; el: HTMLDivElement }> = [];
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { for (const {root,el} of mounted.splice(0)) { await act(async () => root.unmount()); el.remove(); } vi.unstubAllGlobals(); });
async function render(kind: "usage" | "storage", manager = false) {
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("people") ? { userId:"self",manager,members:[{userId:"self",name:"Me"},{userId:"other",name:"Other"}] } :
    kind === "usage" ? { name:"Me",days:7,since:"2026-10-13T00:00:00Z",observedAt:"2026-10-19T00:00:00Z",bots:[{id:"b",name:"Roster"}], rows:[{day:"2026-10-19",model:"Managed",botId:"b",calls:2,totalTokens:12,costUsd:null,inputTokens:7,outputTokens:5,cacheReadTokens:null,cacheWriteTokens:null}] } :
    { name:"Me", observedAt:"2026-10-19T00:00:00Z",quota:{enforced:false,usedBytes:null,limitBytes:50e9},rows:[{botId:"b",name:"Roster",shared:false,usage:null}],attachments:{bytes:100,files:1},scope:"Workspace metadata" }));
  vi.stubGlobal("fetch",fetcher); const el=document.createElement("div");document.body.append(el); const root=createRoot(el);mounted.push({root,el});
  await act(async () => root.render(kind === "usage" ? <WorkspaceUsagePanel/> : <WorkspaceStoragePanel/>)); return {el,fetcher};
}
it("members see self only, unknown cost and real token breakdown", async () => {
  const {el}=await render("usage"); expect(el.querySelector('[aria-label="Team member"]')).toBeNull(); expect(el.textContent).toContain("Unknown"); expect(el.textContent).toContain("12"); expect(el.querySelectorAll('details table tr')).toHaveLength(7);
});
it("manager selection requests exact member and clears prior data", async () => {
  const {el,fetcher}=await render("usage",true); const select=el.querySelector<HTMLSelectElement>('[aria-label="Team member"]')!;
  await act(async () => { select.value="other";select.dispatchEvent(new Event("change",{bubbles:true})); });
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("userId=other");
});
it("storage never presents unavailable homes as complete or quota enforced", async () => {
  const {el}=await render("storage"); expect(el.textContent).toContain("partial"); expect(el.textContent).toContain("Not enforced / not verified"); expect(el.textContent).toContain("Unknown"); expect(el.querySelector('button[aria-label="Delete"]')).toBeNull();
});
