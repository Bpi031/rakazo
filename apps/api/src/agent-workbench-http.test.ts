import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mountAgentWorkbench } from "./agent-workbench-http.js";
function fixture(auth = true, developer = true) {
  const app = new Hono();
  const service = Object.fromEntries(["view", "detail", "goal", "scenario", "scenarioMessage", "saveDraft", "skills", "selectSkill"].map((key) => [key, vi.fn(async () => ({ id: "example" }))]));
  mountAgentWorkbench(app, { service: service as any, actor: async () => auth ? { userId: "u", spaceId: "s", email: "", isDeploymentOwner: false } : null,
    isDeveloper:()=>developer,verifyPassword: async (_r, password) => password === "correct", webOrigin: "https://app.test" });
  const post = (body: unknown, headers = {}) => app.request("https://app.test/api/agent-workbench/decide", { method: "POST", headers: { origin: "https://app.test", cookie: "session=x", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { app, service, post };
}
const goal = { operation: "goal", botId: "b", revision: 0, goal: { objective: "Check exports", status: "active" } };
it('ordinary users cannot open workbench metadata or mutate it by using a direct URL',async()=>{
 const f=fixture(true,false);
 for(const route of ['view','native','detail'])expect((await f.app.request('https://app.test/api/agent-workbench/'+route+'?botId=b')).status).toBe(403);
 expect((await f.post(goal)).status).toBe(403);expect(f.service.view).not.toHaveBeenCalled();expect(f.service.goal).not.toHaveBeenCalled();
});
it("requires a current session for metadata", async () => {
  const f = fixture(false); expect((await f.app.request("https://app.test/api/agent-workbench/view?botId=b")).status).toBe(401);
  expect(f.service.view).not.toHaveBeenCalled();
});
it("binds metadata and mutations to the authenticated actor", async () => {
  const f = fixture(); expect((await f.post(goal)).status).toBe(200);
  expect(f.service.goal).toHaveBeenCalledWith(expect.objectContaining({ userId: "u" }), "b", 0, goal.goal);
});
it.each([{ origin: "https://evil.test" }, { authorization: "Bearer model" }, { cookie: "" }, { "content-type": "text/plain" }])("rejects authority transport %j", async (headers) => {
  const f = fixture(); expect((await f.post(goal, headers)).status).toBe(403); expect(f.service.goal).not.toHaveBeenCalled();
});
it("requires a fresh password and exact digest before saving a separate draft", async () => {
  const f = fixture(); const body = { operation: "save_draft", botId: "b", id: "a1afc5c5-78f2-4bb2-8530-a2d9d98bb411", digest: "a".repeat(64), password: "wrong" };
  expect((await f.post(body)).status).toBe(403); expect(f.service.saveDraft).not.toHaveBeenCalled();
  expect((await f.post({ ...body, password: "correct" })).status).toBe(200);
});
it.each([{ ...goal, userId: "victim" }, { ...goal, solverSeconds: 21600 }, { operation: "install_plugin", botId: "b" }, { operation: "run_hook", botId: "b", command: "shell" }])("rejects smuggled controls %j", async (body) => expect((await fixture().post(body)).status).toBeGreaterThanOrEqual(400));
it("bounds requests and never repeats failed model work", async () => {
  const f = fixture(); expect((await f.post({ ...goal, padding: "x".repeat(40000) })).status).toBe(413);
  f.service.scenarioMessage!.mockRejectedValue(new Error("sensitive provider text"));
  const response = await f.post({ operation: "scenario_message", botId: "b", id: "a1afc5c5-78f2-4bb2-8530-a2d9d98bb411", message: "Compare", nonce: "b1afc5c5-78f2-4bb2-8530-a2d9d98bb411" });
  expect(response.status).toBe(409); expect(await response.text()).not.toContain("sensitive"); expect(f.service.scenarioMessage).toHaveBeenCalledTimes(1);
});
