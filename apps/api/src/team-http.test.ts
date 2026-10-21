import { expect, it, vi } from "vitest";
import { Hono } from "hono";
vi.mock("@rakazo/adapters", async () => {
  const policy = await import("../../../../packages/adapters/src/team-policy.js");
  return { teamHttpSchemas: policy.teamHttpSchemas };
});
import { mountTeamHttp, mountDisabledTeamHttp } from "./team-http.js";
it("returns authenticated structured disabled evidence instead of a text 404", async () => {
  const app = new Hono(); mountDisabledTeamHttp(app, async (req) => req.headers.has("cookie") ? {} : null);
  expect((await app.request("https://test/api/team/overview")).status).toBe(401);
  const response = await app.request("https://test/api/team/overview", { headers: { cookie: "session=x" } });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "TEAM_DISABLED" });
  expect((await app.request("https://test/api/team/propose", { method: "POST", headers: { cookie: "session=x" } })).status).toBe(503);
});
function fixture(additionalWebOrigins: string[] = []) {
  const service: any = { overview: vi.fn(async () => ({ manager: true })), confirm: vi.fn(async () => ({ status: "applied" })),
    propose: vi.fn(async () => ({ status: "pending" })) };
  const verifyPassword = vi.fn(async (_request: Request, password: string) => password === "correct");
  const app = new Hono(); mountTeamHttp(app, { service, verifyPassword, webOrigin: "https://team.test", additionalWebOrigins, actor: async () => ({ userId: "u", spaceId: "s", email: "u@example.com", isDeploymentOwner: false }) });
  const post = (body: unknown, headers = {}, route = "confirm") => app.request("https://team.test/api/team/" + route, { method: "POST", headers: { origin: "https://team.test", "content-type": "application/json", cookie: "session=proof", ...headers }, body: JSON.stringify(body) });
  return { app, service, verifyPassword, post };
}
const input = { id: "p", digest: "a".repeat(64), phrase: "APPLY p", password: "correct" };
it("supports an exact secondary origin without removing action confirmation", async () => {
  const f = fixture(["https://wired.test"]);
  expect((await f.post(input, { origin: "https://wired.test.evil" })).status).toBe(403);
  expect((await f.post(input, { origin: "https://wired.test", cookie: "" })).status).toBe(403);
  expect((await f.post(input, { origin: "https://wired.test", authorization: "Bearer agent" })).status).toBe(403);
  expect((await f.post({ ...input, password: "wrong" }, { origin: "https://wired.test" })).status).toBe(403);
  expect(f.service.confirm).not.toHaveBeenCalled();
  expect((await f.post(input, { origin: "https://wired.test" })).status).toBe(200);
  expect((await fixture().post(input, { origin: "https://wired.test" })).status).toBe(403);
});
it("requires same-origin browser session, exact action phrase and fresh password", async () => {
  const f = fixture();
  expect((await f.post(input, { origin: "https://evil.test" })).status).toBe(403);
  expect((await f.post(input, { authorization: "Bearer agent" })).status).toBe(403);
  expect((await f.post({ ...input, password: "wrong" })).status).toBe(403);
  expect((await f.post({ ...input, phrase: "yes" })).status).toBe(400);
  expect(f.service.confirm).not.toHaveBeenCalled();
  expect((await f.post(input)).status).toBe(200);
  expect(f.service.confirm).toHaveBeenCalledWith(expect.objectContaining({ userId: "u" }), "p", input.digest);
});
it("bounded bodies fail before password check or mutation", async () => {
  const f = fixture(); expect((await f.post({ ...input, padding: "x".repeat(20000) })).status).toBe(413);
  expect(f.verifyPassword).not.toHaveBeenCalled(); expect(f.service.confirm).not.toHaveBeenCalled();
});
it("confirmation attempts have a finite per-user window", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) expect((await f.post({ ...input, password: "wrong" })).status).toBe(403);
  expect((await f.post(input)).status).toBe(429);
  expect(f.service.confirm).not.toHaveBeenCalled();
});
it("messaging-only mode cannot call administrative endpoints",async () => {
  const service:any={propose:vi.fn(),confirm:vi.fn(),overview:vi.fn(async () => ({administrationEnabled:false})),directory:vi.fn(async () => [])};
  const app=new Hono();mountTeamHttp(app,{service,administrationEnabled:false,verifyPassword:vi.fn(),webOrigin:"https://test",actor:async () => ({userId:"u",spaceId:"s",email:"e",isDeploymentOwner:false})});
  for(const route of ["propose","confirm","actions"]) expect((await app.request("https://test/api/team/"+route)).status).toBe(503);
  expect(service.propose).not.toHaveBeenCalled();expect(service.confirm).not.toHaveBeenCalled();
  expect((await app.request("https://test/api/team/directory")).status).toBe(200);
});
