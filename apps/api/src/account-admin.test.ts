import { expect, it, vi } from "vitest";
import { Hono } from "hono";
const auth = vi.hoisted(() => ({ memberScope: vi.fn() }));
vi.mock("@rakazo/adapters", async () => {
  const policy = await import("../../../../packages/adapters/src/team-policy.js");
  return { ...policy, memberScope: auth.memberScope };
});
import { AccountAdminService, mountAccountAdmin } from "./account-admin.js";
const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
function fixture(role = "owner") {
  const settings = {
    ownerUserId: "owner",
    signupPolicyInitialized: true,
    signupsEnabled: false,
    signupAllowlist: "@example.test",
  };
  const scope = { organizationId: "org", role };
  auth.memberScope.mockResolvedValue(scope);
  const team: any = {
    scope: vi.fn(async () => {
      if (role === "member") throw new Error("Manager required");
      return scope;
    }),
    proposals: vi.fn(async () => []),
    propose: vi.fn(async () => ({ status: "pending" })),
    confirm: vi.fn(async () => ({ status: "applied" })),
  };
  const db: any = {
    deploymentSettings: {
      findUnique: vi.fn(async () => settings),
      update: vi.fn(async () => settings),
    },
    member: {
      findMany: vi.fn(async () => [
        {
          userId: "owner",
          role: "owner",
          user: { name: "Owner", email: actor.email, emailVerified: true },
        },
        {
          userId: "member",
          role: "member",
          user: { name: "Member", email: "member@example.test", emailVerified: false },
        },
      ]),
    },
    teamMemberControl: { findMany: vi.fn(async () => []) },
    teamInvite: { findMany: vi.fn(async () => []) },
    teamAction: { findFirst: vi.fn() },
    teamAudit: { create: vi.fn() },
    $executeRaw: vi.fn(),
  };
  db.$transaction = async (work: any) => work(db);
  const service = new AccountAdminService(db, team, { enabled: false, allowlist: [] });
  const verifyPassword = vi.fn(
    async (_request: Request, password: string) => password === "correct",
  );
  const app = new Hono();
  mountAccountAdmin(app, {
    service,
    webOrigin: "https://team.test",
    additionalWebOrigins: ["https://other.test"],
    verifyPassword,
    actor: async (req) => (req.headers.has("cookie") ? actor : null),
  });
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request("https://team.test/api/account-admin/" + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://team.test",
        cookie: "session=x",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { service, team, db, settings, verifyPassword, app, post };
}
async function registration(f: ReturnType<typeof fixture>, changes = {}) {
  return {
    enabled: true,
    allowlist: [],
    digest: (await f.service.view(actor)).registration!.digest,
    phrase: "APPLY REGISTRATION",
    password: "correct",
    ...changes,
  };
}
it("registration state is owner-only and account metadata is same-organization and bounded", async () => {
  const f = fixture();
  const view = await f.service.view(actor);
  expect(view.registration).toMatchObject({ enabled: false, allowlist: ["@example.test"] });
  expect(view.members[0]?.protected).toBe(true);
  expect(view.members[1]?.protected).toBe(false);
  expect(f.db.member.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { organizationId: "org" }, take: 201 }),
  );
  expect((await f.service.view({ ...actor, isDeploymentOwner: false })).registration).toBeNull();
  await expect(fixture("member").service.view(actor)).rejects.toThrow("Manager");
});
it("a stale deployment-owner hint cannot read or change server registration", async () => {
  const f = fixture();
  f.settings.ownerUserId = "another";
  expect((await f.service.view(actor)).registration).toBeNull();
  await expect(
    f.service.registration(actor, {
      enabled: true,
      allowlist: [],
      digest: "a".repeat(64),
      phrase: "APPLY REGISTRATION",
      password: "correct",
    }),
  ).rejects.toThrow();
  expect(f.db.deploymentSettings.update).not.toHaveBeenCalled();
});
it("registration saves only explicit reviewed fields, normalizes emails and audits without passwords", async () => {
  const f = fixture();
  await f.service.registration(
    actor,
    await registration(f, { allowlist: ["NEW@example.test", "new@example.test", "@Example.test"] }),
  );
  expect(f.db.deploymentSettings.update).toHaveBeenCalledWith({
    where: { id: "default" },
    data: {
      signupsEnabled: true,
      signupAllowlist: "new@example.test,@example.test",
      signupPolicyInitialized: true,
    },
  });
  expect(JSON.stringify(f.db.teamAudit.create.mock.calls)).not.toContain("correct");
});
it("a stale registration review or revoked live role cannot write", async () => {
  const f = fixture();
  const input = await registration(f);
  f.settings.signupAllowlist = "@changed.test";
  await expect(f.service.registration(actor, input)).rejects.toThrow("changed");
  auth.memberScope.mockResolvedValue({ organizationId: "org", role: "member" });
  await expect(f.service.registration(actor, await registration(f))).rejects.toThrow(
    "authorization",
  );
  expect(f.db.deploymentSettings.update).not.toHaveBeenCalled();
});
it("uninitialized policy reads actual environment defaults, not schema defaults", async () => {
  const f = fixture();
  f.settings.signupPolicyInitialized = false;
  f.settings.signupsEnabled = true;
  expect((await f.service.view(actor)).registration).toMatchObject({
    enabled: false,
    allowlist: [],
  });
});
it("non-account proposals and confirmations cannot bypass the storage-management gate", async () => {
  const f = fixture();
  await expect(
    f.service.propose(actor, { action: { kind: "bot_delete", botId: "b" } }),
  ).rejects.toThrow();
  f.db.teamAction.findFirst.mockResolvedValue({
    action: { kind: "quota", userId: "member", bytes: 50_000_000_000 },
  });
  await expect(
    f.service.confirm(actor, {
      id: "p",
      digest: "a".repeat(64),
      phrase: "APPLY p",
      password: "correct",
    }),
  ).rejects.toThrow();
  expect(f.team.propose).not.toHaveBeenCalled();
  expect(f.team.confirm).not.toHaveBeenCalled();
});
it("requires same-origin browser authentication and a fresh correct password", async () => {
  const f = fixture();
  const input = await registration(f);
  expect((await f.app.request("https://team.test/api/account-admin/view")).status).toBe(401);
  for (const headers of [
    { origin: "https://evil.test" },
    { authorization: "Bearer agent" },
    { cookie: "" },
  ])
    expect((await f.post("registration", input, headers)).status).toBe(403);
  expect((await f.post("registration", { ...input, password: "wrong" })).status).toBe(403);
  expect(f.db.deploymentSettings.update).not.toHaveBeenCalled();
  expect((await f.post("registration", input, { origin: "https://other.test" })).status).toBe(200);
});
it("denies non-managers before password verification or mutation", async () => {
  const f = fixture("member");
  const result = await f.post("registration", {
    enabled: true,
    allowlist: [],
    digest: "a".repeat(64),
    phrase: "APPLY REGISTRATION",
    password: "correct",
  });
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(f.verifyPassword).not.toHaveBeenCalled();
});
it("oversized bodies, invalid emails, extra privileges and missing confirmation fail closed", async () => {
  const f = fixture();
  const input = await registration(f);
  expect((await f.post("registration", { ...input, padding: "x".repeat(17000) })).status).toBe(413);
  for (const change of [
    { allowlist: ["*@example.test"] },
    { allowlist: ["not-an-email"] },
    { ownerUserId: "attacker" },
    { phrase: "yes" },
  ])
    expect((await f.post("registration", { ...input, ...change })).status).toBe(400);
  expect(f.db.deploymentSettings.update).not.toHaveBeenCalled();
});
it("rate limits fresh-password attempts and never caches successful approval", async () => {
  const f = fixture();
  const input = await registration(f);
  for (let i = 0; i < 5; i++)
    expect((await f.post("registration", { ...input, password: "wrong" })).status).toBe(403);
  expect((await f.post("registration", input)).status).toBe(429);
  expect(f.db.deploymentSettings.update).not.toHaveBeenCalled();
});
