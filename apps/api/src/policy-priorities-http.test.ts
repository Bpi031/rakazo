import { beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
vi.mock("@rakazo/adapters", async () => {
  const module = await import("../../../../packages/adapters/src/policy-priorities.js"); return { prioritySchemas: module.prioritySchemas };
});
import { mountPriorityHttp } from "./policy-priorities-http.js";
const actor = { userId: "u", spaceId: "s", email: "test@example.invalid", isDeploymentOwner: false };
const id = "e375d057-e532-4416-b617-3a6d2ab5a7c1"; const digest = "a".repeat(64);
let app: Hono; let service: any; let auth: any; let verify: any;
beforeEach(() => {
  app = new Hono(); service = { inspect: vi.fn().mockResolvedValue({ rules: [] }), current: vi.fn().mockResolvedValue({ status: "current" }),
    review: vi.fn().mockResolvedValue({ id }), get: vi.fn().mockResolvedValue({ id }), apply: vi.fn().mockResolvedValue({ applied: true }) };
  auth = vi.fn().mockResolvedValue(actor); verify = vi.fn().mockResolvedValue(true);
  mountPriorityHttp(app, { service, actor: auth, verifyPassword: verify, webOrigin: "https://test", additionalWebOrigins: ["https://wired.test"] });
});
function post(route: string, data: unknown, headers: Record<string, string> = {}) {
  return app.request("https://test/api/rule-priorities/" + route, { method: "POST", headers: {
    origin: "https://test", "content-type": "application/json", cookie: "session=test-only", ...headers }, body: JSON.stringify(data) });
}
const input = { id, digest, password: "not-a-real-password", phrase: "CREATE DRAFT " + id };
it("accepts the secondary origin only with the same session and fresh confirmation gates", async () => {
  expect((await post("apply", input, { origin: "https://wired.test.evil" })).status).toBe(403);
  expect((await post("apply", input, { origin: "https://wired.test", cookie: "" })).status).toBe(403);
  expect((await post("apply", input, { origin: "https://wired.test", authorization: "Bearer agent" })).status).toBe(403);
  expect((await post("apply", { ...input, phrase: "yes" }, { origin: "https://wired.test" })).status).toBe(403);
  verify.mockResolvedValue(false);
  expect((await post("apply", input, { origin: "https://wired.test" })).status).toBe(403);
  expect(service.apply).not.toHaveBeenCalled();
  verify.mockResolvedValue(true);
  expect((await post("apply", input, { origin: "https://wired.test" })).status).toBe(200);
});
it("requires a live authenticated owner", async () => {
  auth.mockResolvedValue(null);
  expect((await app.request("https://test/api/rule-priorities/current?botId=b")).status).toBe(401);
  expect((await post("apply", input)).status).toBe(401); expect(service.apply).not.toHaveBeenCalled();
});
it("only applies after same-origin session, exact confirmation and fresh password", async () => {
  expect((await post("apply", input, { origin: "https://evil" })).status).toBe(403);
  expect((await post("apply", input, { authorization: "Bearer agent-token" })).status).toBe(403);
  expect((await post("apply", input, { cookie: "" })).status).toBe(403);
  expect((await post("apply", { ...input, phrase: "yes" })).status).toBe(403);
  verify.mockResolvedValue(false); expect((await post("apply", input)).status).toBe(403);
  expect(service.apply).not.toHaveBeenCalled(); verify.mockResolvedValue(true);
  expect((await post("apply", input)).status).toBe(200);
  expect(service.apply).toHaveBeenCalledWith(actor, id, digest);
});
it("bounds body size and password attempts without calling the helper", async () => {
  expect((await post("review", { huge: "x".repeat(65536) })).status).toBe(413);
  verify.mockResolvedValue(false);
  for (let i = 0; i < 5; i++) expect((await post("apply", input)).status).toBe(403);
  expect((await post("apply", input)).status).toBe(429); expect(verify).toHaveBeenCalledTimes(5);
  expect(service.apply).not.toHaveBeenCalled();
});
it("loads current/proposed rules without applying and sanitizes backend failures", async () => {
  const response = await app.request("https://test/api/rule-priorities/current?botId=b");
  expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.status).toBe(200);
  expect((await app.request("https://test/api/rule-priorities/review/" + id)).status).toBe(200);
  service.inspect.mockRejectedValue(new Error("private backend path"));
  const failed = await post("inspect", { botId: "b", policy: "workspace/case/policy.rost", workingDirectory: "workspace/case" });
  expect(failed.status).toBe(409); expect(await failed.text()).not.toContain("private backend path");
  expect(service.apply).not.toHaveBeenCalled();
});
