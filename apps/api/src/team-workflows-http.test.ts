import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mountTeamWorkflows } from "./team-workflows-http.js";
function fixture(authenticated = true) {
  const app = new Hono();
  const service = { list: vi.fn(async () => []), decide: vi.fn(async () => ({ ok: true })) };
  const password = vi.fn(async (_r: Request, p: string) => p === "correct");
  mountTeamWorkflows(app, {
    service: service as any,
    leadership: service as any,
    actor: async () =>
      authenticated ? { userId: "u", spaceId: "s", email: "", isDeploymentOwner: false } : null,
    verifyPassword: password,
    webOrigin: "https://team.test",
  });
  const post = (body: unknown, headers = {}) =>
    app.request("https://team.test/api/team-workflows/decide", {
      method: "POST",
      headers: {
        origin: "https://team.test",
        "content-type": "application/json",
        cookie: "session=x",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { app, service, password, post };
}
const input = { id: "f", digest: "d".repeat(64), operation: "enable", password: "correct" };
it("requires an authenticated session for metadata", async () => {
  const f = fixture(false);
  expect((await f.app.request("https://team.test/api/team-workflows/list")).status).toBe(401);
  expect(f.service.list).not.toHaveBeenCalled();
});
it.each(["enable", "pause", "consent", "revoke"])(
  "confirms %s only in a password-checked browser session",
  async (operation) => {
    const f = fixture();
    const response = await f.post({ ...input, operation });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.service.decide).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u" }),
      "f",
      input.digest,
      operation,
    );
  },
);
it.each([
  { origin: "https://evil.test" },
  { authorization: "Bearer agent" },
  { cookie: "" },
  { "content-type": "text/plain" },
])("rejects non-browser confirmation %j", async (headers) => {
  const f = fixture();
  expect((await f.post(input, headers)).status).toBe(403);
  expect(f.service.decide).not.toHaveBeenCalled();
});
it.each([
  { password: "wrong" },
  { digest: "wrong" },
  { operation: "approve_policy" },
  { userId: "victim" },
  { files: ["/etc/passwd"] },
])("rejects invalid authorization or smuggling %j", async (change) => {
  const f = fixture();
  expect((await f.post({ ...input, ...change })).status).toBeGreaterThanOrEqual(400);
  expect(f.service.decide).not.toHaveBeenCalled();
});
it("bounds body size and password attempts", async () => {
  const f = fixture();
  expect((await f.post({ ...input, password: "x".repeat(20000) })).status).toBe(413);
  for (let i = 0; i < 5; i++)
    expect((await f.post({ ...input, password: "wrong" })).status).toBe(403);
  expect((await f.post(input)).status).toBe(429);
  expect(f.service.decide).not.toHaveBeenCalled();
});
it.each(["offer", "accept", "decline", "cancel"])(
  "leadership %s uses the same authenticated confirmation boundary",
  async (operation) => {
    const f = fixture();
    const response = await f.app.request("https://team.test/api/team-leadership/decide", {
      method: "POST",
      headers: {
        origin: "https://team.test",
        "content-type": "application/json",
        cookie: "session=x",
      },
      body: JSON.stringify({ ...input, operation }),
    });
    expect(response.status).toBe(200);
    expect(f.service.decide).toHaveBeenCalledWith(expect.anything(), "f", input.digest, operation);
  },
);
