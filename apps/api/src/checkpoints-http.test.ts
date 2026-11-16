import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@rakazo/contracts";
import type { CheckpointService } from "@rakazo/adapters";
import { mountCheckpointHttp } from "./checkpoints-http.js";

const actor: Actor = { userId: "user", spaceId: "space", email: "", isDeploymentOwner: false };
function fixture(authenticated = true) {
  const app = new Hono();
  const service = {
    status: vi.fn().mockResolvedValue({ generation: 2, blocked: false, revision: "2:false:saved" }),
    list: vi.fn().mockResolvedValue({ generation: 2, checkpoints: [] }),
    create: vi.fn().mockResolvedValue({ id: "saved" }),
    rollback: vi.fn().mockResolvedValue({ ok: true, generation: 3, rescueCheckpointId: "rescue" }),
    audit: vi.fn().mockResolvedValue({ schema: "rakazo/checkpoint-audit/v1", messages: [] }),
  };
  mountCheckpointHttp(app, {
    service: service as unknown as CheckpointService,
    actor: async () => (authenticated ? actor : null),
    webOrigin: "https://app.example",
  });
  return { app, service };
}
const post = (body: unknown, origin = "https://app.example") => ({
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("checkpoint HTTP", () => {
  it("serves lightweight status without loading snapshot history", async () => {
    const { app, service } = fixture();
    const response = await app.request("/api/checkpoints/status?botId=bot");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: "2:false:saved" });
    expect(service.status).toHaveBeenCalledWith(actor, "bot");
    expect(service.list).not.toHaveBeenCalled();
  });
  it("requires authentication for history and audit exports", async () => {
    const { app, service } = fixture(false);
    expect((await app.request("/api/checkpoints?botId=bot")).status).toBe(401);
    expect((await app.request("/api/checkpoints/audit?botId=bot")).status).toBe(401);
    expect(service.audit).not.toHaveBeenCalled();
  });
  it("rejects cross-origin mutation before invoking the service", async () => {
    const { app, service } = fixture();
    expect(
      (
        await app.request(
          "/api/checkpoints",
          post({ botId: "bot", expectedGeneration: 2 }, "https://other.example"),
        )
      ).status,
    ).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
  });
  it("passes authenticated scope and expected generation to save", async () => {
    const { app, service } = fixture();
    expect(
      (
        await app.request(
          "/api/checkpoints",
          post({ botId: "bot", label: "Ready", expectedGeneration: 2 }),
        )
      ).status,
    ).toBe(201);
    expect(service.create).toHaveBeenCalledWith(actor, {
      botId: "bot",
      label: "Ready",
      expectedGeneration: 2,
    });
  });
  it("refuses mismatched checkpoint ids and extra client-owned snapshot fields", async () => {
    const { app, service } = fixture();
    expect(
      (
        await app.request(
          "/api/checkpoints/a/rollback",
          post({ botId: "bot", checkpointId: "b", expectedGeneration: 2 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          "/api/checkpoints",
          post({ botId: "bot", expectedGeneration: 2, fileManifest: {} }),
        )
      ).status,
    ).toBe(409);
    expect(service.rollback).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
  });
  it("returns a blocked recovery as conflict, never success", async () => {
    const { app, service } = fixture();
    service.rollback.mockResolvedValue({ ok: false, generation: 3, error: "Workspace blocked" });
    const response = await app.request(
      "/api/checkpoints/a/rollback",
      post({ botId: "bot", checkpointId: "a", expectedGeneration: 2 }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, generation: 3 });
  });
  it("rejects the removed Undo option", async () => {
    const { app, service } = fixture();
    const input = { botId: "bot", checkpointId: "rescue", expectedGeneration: 2, undo: true };
    const response = await app.request("/api/checkpoints/rescue/rollback", post(input));
    expect(response.status).toBe(409);
    expect(service.rollback).not.toHaveBeenCalled();
  });
  it("exports audit JSON with no-store and a download name", async () => {
    const { app, service } = fixture();
    const response = await app.request("/api/checkpoints/audit?botId=bot");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("checkpoint-audit.json");
    expect(service.audit).toHaveBeenCalledWith(actor, "bot");
  });
});
