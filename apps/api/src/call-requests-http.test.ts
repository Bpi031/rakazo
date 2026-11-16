import type { Actor } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CallRequestError } from "./call-requests.js";
import { mountCallRequestHttp } from "./call-requests-http.js";

const origin = "https://app.example.test";
const actor: Actor = {
  userId: "manager",
  spaceId: "clinic",
  email: "manager@example.test",
  isDeploymentOwner: false,
};
function fixture(signedIn = true) {
  const app = new Hono();
  const service = {
    manage: vi.fn(async () => ({ requests: [] })),
    upsertDoctors: vi.fn(async () => ({ ok: true })),
    managerRemove: vi.fn(async () => ({ ok: true })),
    sendCode: vi.fn(async () => ({ ok: true })),
    verify: vi.fn(async () => "a".repeat(64)),
    own: vi.fn(async () => ({ requests: [] })),
    save: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
    logout: vi.fn(async () => ({ ok: true })),
  };
  mountCallRequestHttp(app, {
    service: service as never,
    actor: async () => (signedIn ? actor : null),
    webOrigin: origin,
  });
  const post = (path: string, body: unknown = {}, headers = {}) =>
    app.request(`/api/call-requests/${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { app, service, post };
}

describe("call request HTTP boundary", () => {
  it("allows doctor login without a Rakazo account but protects manager routes", async () => {
    const { app, post, service } = fixture(false);
    expect((await post("clinic/code", { email: "doctor@example.test" })).status).toBe(200);
    expect(
      (await post("clinic/verify", { email: "doctor@example.test", code: "123456" })).status,
    ).toBe(200);
    expect((await app.request("/api/call-requests/manage?month=2026-11")).status).toBe(401);
    expect((await post("manage/doctors", { doctors: [] })).status).toBe(401);
    expect(service.upsertDoctors).not.toHaveBeenCalled();
  });

  it("sets a scoped HttpOnly secure cookie without exposing the token in JSON", async () => {
    const { post } = fixture();
    const response = await post("clinic/verify", { email: "doctor@example.test", code: "123456" });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain("Path=/api/call-requests/clinic");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects missing/foreign origins and non-JSON requests before invoking writes", async () => {
    const { app, service, post } = fixture();
    expect(
      (await post("clinic/requests", {}, { origin: "https://evil.example.test" })).status,
    ).toBe(403);
    expect(
      (await app.request("/api/call-requests/clinic/requests", { method: "POST", body: "{}" }))
        .status,
    ).toBe(403);
    expect(service.save).not.toHaveBeenCalled();
  });

  it("passes only the scoped doctor cookie and URL space to doctor operations", async () => {
    const { app, service } = fixture();
    await app.request("/api/call-requests/clinic?month=2026-11", {
      headers: { cookie: `rakazo_call_doctor=${"b".repeat(64)}; rakazo.session_token=manager` },
    });
    expect(service.own).toHaveBeenCalledWith("clinic", "b".repeat(64), "2026-11");
  });

  it("clears the same cookie path on logout", async () => {
    const { post } = fixture();
    const response = await post("clinic/logout");
    expect(response.headers.get("set-cookie")).toContain("Path=/api/call-requests/clinic");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rejects oversized and malformed JSON and does not leak unexpected errors", async () => {
    const { app, post, service } = fixture();
    expect((await post("manage/doctors", { data: "x".repeat(513 * 1024) })).status).toBe(400);
    expect(service.upsertDoctors).not.toHaveBeenCalled();
    const malformed = await app.request("/api/call-requests/clinic/code", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    service.sendCode.mockRejectedValueOnce(new Error("private database connection"));
    const response = await post("clinic/code", {});
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database");
  });

  it("preserves authentication failures for the public login screen", async () => {
    const { app, service } = fixture(false);
    service.own.mockRejectedValueOnce(new CallRequestError(401, "Verify your email to continue"));
    const response = await app.request("/api/call-requests/clinic?month=2026-11");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
