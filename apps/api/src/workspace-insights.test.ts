import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), quota: vi.fn() }));
vi.mock("@rakazo/adapters", () => ({ managerRole: (role: string) => ["owner","admin"].includes(role), memberScope: mocks.scope,
  memberStorageKey: () => "opaque", quotaCall: mocks.quota, toComputerRef: (c: any) => ({id:c.providerRef,botId:c.homeKey,kind:c.kind,providerRef:c.providerRef}) }));
import { mountWorkspaceInsights, WorkspaceInsights, sumUsage, storageProbe } from "./workspace-insights.js";
const actor = { userId: "self", spaceId: "space", email: "self@example.test", isDeploymentOwner: false };
function fixture(role = "member") {
  mocks.scope.mockResolvedValue({ organizationId: "org", role }); mocks.quota.mockRejectedValue(new Error("No quota service"));
  const db: any = { member: { findUnique: vi.fn(async ({ where }: any) => where.organizationId_userId.userId === "outside" ? null : { user: { name: "Member" } }), findMany: vi.fn(async () => []) },
    teamMemberControl: { findUnique: vi.fn(async () => null) }, bot: { findMany: vi.fn(async () => []) },
    artifact: { aggregate: vi.fn(async () => ({ _sum: { size: 10 }, _count: { _all: 1 } })) }, $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn() };
  db.$transaction = async (work: any) => work(db);
  const sandbox: any = { execute: vi.fn() }; const service = new WorkspaceInsights(db, sandbox);
  return { db, sandbox, service };
}
it("rejects cross-user member queries before querying spend or probing computers", async () => {
  const f = fixture(); await expect(f.service.usage(actor, new URLSearchParams({ userId: "other" }))).rejects.toThrow();
  await expect(f.service.storage(actor,"other")).rejects.toThrow(); expect(f.db.$queryRaw).not.toHaveBeenCalled(); expect(f.sandbox.execute).not.toHaveBeenCalled();
});
it("manager queries are pinned to active same-organization membership, not deployment-owner hints", async () => {
  const f = fixture("owner"); await expect(f.service.scope(actor,"outside")).rejects.toThrow();
  f.db.teamMemberControl.findUnique.mockResolvedValue({ state: "suspended" });
  await expect(f.service.scope(actor,"other")).rejects.toThrow(); expect(f.db.$queryRaw).not.toHaveBeenCalled();
});
it("SQL aggregation binds organization, user and filters without interpolated SQL", async () => {
  const f = fixture("admin"); await f.service.usage(actor,new URLSearchParams({ userId:"other", model:"m' OR TRUE --", days:"7" }));
  const query = f.db.$queryRaw.mock.calls[0][0]; expect(query.values).toContain("org"); expect(query.values).toContain("other"); expect(query.values).toContain("m' OR TRUE --");
  expect(query.sql).not.toContain("OR TRUE"); await expect(f.service.usage(actor,new URLSearchParams({ days:"999" }))).rejects.toThrow();
});
it("unknown accounting never becomes a zero or a partially priced total", () => {
  const r: any = { day:"2026-10-19",model:"m",botId:"b",calls:1,costUsd:null,inputTokens:2,outputTokens:3,totalTokens:5,cacheReadTokens:null,cacheWriteTokens:null };
  expect(sumUsage([r,{ ...r, costUsd:1 }])).toMatchObject({ calls:2, costUsd:null,totalTokens:10,cacheReadTokens:null });
});
it("unavailable storage does not provision computers or claim enforcement; response cache is scope checked", async () => {
  const f = fixture(); f.db.bot.findMany.mockResolvedValue([{ id:"b",name:"Bot",computer:null }]);
  const result: any = await f.service.storage(actor); expect(result.rows[0].usage).toBeNull(); expect(result.quota.enforced).toBe(false); expect(result.quota.usedBytes).toBeNull();
  expect(f.sandbox.execute).not.toHaveBeenCalled(); mocks.scope.mockRejectedValue(new Error("revoked")); await expect(f.service.storage(actor)).rejects.toThrow();
});
it("HTTP is authenticated, no-store, bounded and rejects ambiguous/path filters", async () => {
  const f = fixture(); const app = new Hono(); mountWorkspaceInsights(app,f.service,async (request) => request.headers.has("cookie") ? actor : null);
  expect((await app.request("http://test/api/workspace/usage")).status).toBe(401);
  for (const route of ["storage?path=/etc","usage?days=7&days=30","storage?userId=other"]) {
    const r = await app.request("http://test/api/workspace/"+route,{ headers:{ cookie:"session=x" } }); expect(r.status).toBeGreaterThanOrEqual(400); expect(r.headers.get("cache-control")).toBe("no-store");
  }
});
it("measures the authorized native home reference once and never follows another owner's computer", async () => {
  const f=fixture(); const computer={id:"db-computer",userId:"self",homeKey:"native-home",providerRef:"container-id",kind:"docker",state:"running"};
  f.db.bot.findMany.mockResolvedValue([{id:"b",name:"B",spaceId:"space",computer},{id:"b2",name:"B2",spaceId:"space",computer},
    {id:"x",name:"X",spaceId:"space",computer:{...computer,userId:"other",homeKey:"foreign"}}]);
  f.sandbox.execute.mockImplementation(async function* () { yield {type:"stdout",data:JSON.stringify({workspace:[50,1,true],Downloads:[0,0,true]})}; yield {type:"exit",code:0}; });
  const result:any=await f.service.storage(actor); expect(f.sandbox.execute).toHaveBeenCalledTimes(1);
  expect(f.sandbox.execute.mock.calls[0][0]).toMatchObject({id:"container-id",botId:"native-home"});
  expect(result.rows[1].shared).toBe(true);expect(result.rows[2].usage).toBeNull();
});
it("native metadata traversal ignores links and home secrets, deduplicates hardlinks and reports finite truncation", () => {
  const root=mkdtempSync(path.join(tmpdir(),"storage-probe-")); const home=path.join(root,"home");
  try {
    mkdirSync(path.join(home,"workspace"),{recursive:true}); mkdirSync(path.join(home,"Downloads"));
    writeFileSync(path.join(home,"workspace","data"),"abc"); linkSync(path.join(home,"workspace","data"),path.join(home,"workspace","duplicate"));
    writeFileSync(path.join(home,"Downloads","file"),"abcd"); writeFileSync(path.join(home,"gurobi.lic"),"fictional-secret-not-readable");
    symlinkSync(root,path.join(home,"workspace","escape"));
    const code=storageProbe.replace("'/home/rakazo'",JSON.stringify(home));
    const result=JSON.parse(execFileSync("python3",["-I","-c",code],{timeout:5000}).toString());
    expect(result).toEqual({workspace:[3,1,true],Downloads:[4,1,true]});
    const truncated=JSON.parse(execFileSync("python3",["-I","-c",code.replace("remaining=25000","remaining=0")],{timeout:5000}).toString());
    expect(truncated.workspace[2]).toBe(false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
