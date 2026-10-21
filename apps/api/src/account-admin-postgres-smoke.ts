// Requires an empty, disposable, migrated database. No external email, model or solver.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, requireMembership } from "@rakazo/db";
import { createAuth, resolveSignupPolicy } from "@rakazo/auth";
import { TeamService } from "@rakazo/adapters";
import { AccountAdminService } from "./account-admin.js";

const url = new URL(process.env.DATABASE_URL ?? "http://missing");
if (
  process.env.ROST_DISPOSABLE_ACCOUNTS_DB !== "1" ||
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/rost_account_admin_test"
)
  throw new Error("Explicit isolated account database required");
const { prisma: db, pool } = createDb(url.href);
let checks = 0;
function enrollmentToken(value: unknown): string {
  assert.ok(value && typeof value === "object" && "enrollmentToken" in value && typeof value.enrollmentToken === "string");
  return value.enrollmentToken;
}
try {
  assert.equal(await db.user.count(), 0, "Account smoke requires an empty database");
  process.env.TEAM_MANAGEMENT_ENABLED = "0";
  process.env.TEAM_MESSAGING_ENABLED = "1";
  await db.deploymentSettings.create({
    data: {
      id: "default",
      signupsEnabled: true,
      signupAllowlist: "",
      signupPolicyInitialized: true,
    },
  });
  const env = {
    secret: "offline-account-fixture-secret-with-at-least-32-bytes",
    baseURL: "https://account.example.invalid",
    webOrigin: "https://account.example.invalid",
    signupsEnabled: "false",
    signupAllowlist: "@old.example.invalid",
  };
  const auth = createAuth(db, env);
  const request = (path: string, body: unknown) =>
    auth.handler(
      new Request(env.baseURL + "/api/auth/" + path, {
        method: "POST",
        headers: { origin: env.webOrigin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const credentials = { email: "owner@example.test", password: "OfflineAccountFixture2397!" };
  const signup = await request("sign-up/email", { ...credentials, name: "Fixture owner" });
  assert.equal(signup.status, 200, "Initial fixture signup failed");
  checks++;
  const user = await db.user.findUniqueOrThrow({ where: { email: credentials.email } });
  await db.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  const actor = await requireMembership(db, user.id);
  assert.equal(actor.isDeploymentOwner, true);
  checks++;
  const member = await db.member.findFirstOrThrow({ where: { userId: actor.userId } });
  const organizationId = member.organizationId;
  const team = new TeamService({ prisma: db, jobs: { enqueue: async () => {} } } as any);
  const service = new AccountAdminService(db, team, { enabled: false, allowlist: [] });
  const changeRegistration = async (enabled: boolean) =>
    service.registration(actor, {
      enabled,
      allowlist: [],
      digest: (await service.view(actor)).registration!.digest,
      phrase: "APPLY REGISTRATION",
      password: credentials.password,
    });
  const original = (await service.view(actor)).registration!;
  await changeRegistration(false);
  assert.equal((await resolveSignupPolicy(db, env)).enabled, false);
  checks++;
  assert.equal(
    (
      await request("sign-up/email", {
        email: "blocked@example.test",
        password: credentials.password,
        name: "Blocked",
      })
    ).status,
    400,
  );
  checks++;
  assert.equal(await db.user.count({ where: { email: "blocked@example.test" } }), 0);
  checks++;
  assert.equal(
    (await request("sign-in/email", credentials)).status,
    200,
    "Closed signup must not lock out existing users",
  );
  checks++;
  await assert.rejects(
    service.registration(actor, {
      ...original,
      enabled: true,
      phrase: "APPLY REGISTRATION",
      password: credentials.password,
    }),
  );
  checks++;
  await changeRegistration(true);
  assert.equal(
    (
      await request("sign-up/email", {
        email: "new@example.test",
        password: credentials.password,
        name: "New fixture",
      })
    ).status,
    200,
  );
  checks++;
  await changeRegistration(false);
  const ids: string[] = [];
  for (const name of ["member", "manager", "invited", "revoked", "unverified"]) {
    const id = randomUUID();
    ids.push(id);
    await db.user.create({
      data: {
        id,
        name: "Fixture " + name,
        email: name + "@example.test",
        emailVerified: name !== "unverified",
      },
    });
  }
  for (const [index, userId] of ids.slice(0, 2).entries()) {
    await db.member.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId,
        role: index === 0 ? "member" : "admin",
        createdAt: new Date(),
      },
    });
    const space = await db.space.create({
      data: { id: randomUUID(), organizationId, name: "Private fixture", createdByUserId: userId },
    });
    await db.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: space.id,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  }
  const ordinary = await requireMembership(db, ids[0]!);
  const manager = await requireMembership(db, ids[1]!);
  await assert.rejects(service.view(ordinary));
  checks++;
  assert.equal((await service.view(manager)).registration, null);
  checks++;
  await assert.rejects(
    service.registration(manager, {
      enabled: true,
      allowlist: [],
      digest: (await service.view(actor)).registration!.digest,
      phrase: "APPLY REGISTRATION",
      password: credentials.password,
    }),
  );
  checks++;
  await assert.rejects(
    team.propose(
      actor,
      { kind: "member_state", userId: actor.userId, state: "suspended" },
      "dashboard",
    ),
  );
  checks++;
  await assert.rejects(
    team.propose(manager, { kind: "member_role", userId: ids[0], role: "admin" }, "dashboard"),
  );
  checks++;
  const apply = async (action: unknown) => {
    const review = await service.propose(actor, { action });
    return service.confirm(actor, {
      id: review.id,
      digest: review.digest,
      phrase: "APPLY " + review.id,
      password: credentials.password,
    });
  };
  await apply({ kind: "member_role", userId: ids[0], role: "admin" });
  assert.equal(
    (
      await db.member.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId, userId: ids[0]! } },
      })
    ).role,
    "admin",
  );
  checks++;
  await apply({ kind: "member_state", userId: ids[0], state: "suspended" });
  await assert.rejects(requireMembership(db, ids[0]!));
  checks++;
  await apply({ kind: "member_state", userId: ids[0], state: "active" });
  assert.equal((await requireMembership(db, ids[0]!)).userId, ids[0]);
  checks++;
  const invite = await apply({ kind: "invite", email: "invited@example.test", role: "member" });
  assert.ok("enrollmentToken" in invite && typeof invite.enrollmentToken === "string");
  await team.acceptInvite(
    { ...actor, userId: ids[2]!, email: "invited@example.test", isDeploymentOwner: false },
    invite.enrollmentToken as string,
  );
  checks++;
  await assert.rejects(team.acceptInvite(actor, invite.enrollmentToken as string));
  checks++;
  const revoke = await apply({ kind: "invite", email: "revoked@example.test", role: "member" });
  const pending = await db.teamInvite.findFirstOrThrow({
    where: { organizationId, email: "revoked@example.test", status: "pending" },
  });
  await apply({ kind: "invite_revoke", inviteId: pending.id });
  await assert.rejects(
    team.acceptInvite(
      { ...actor, userId: ids[3]!, email: "revoked@example.test", isDeploymentOwner: false },
      enrollmentToken(revoke),
    ),
  );
  checks++;
  const unverified = await apply({
    kind: "invite",
    email: "unverified@example.test",
    role: "member",
  });
  await assert.rejects(
    team.acceptInvite(
      { ...actor, userId: ids[4]!, email: "unverified@example.test", isDeploymentOwner: false },
      enrollmentToken(unverified),
    ),
  );
  checks++;
  assert.equal(await db.run.count(), 0);
  checks++;
  assert.equal(await db.computer.count(), 0);
  checks++;
  assert.equal(
    JSON.stringify(await service.view(actor)).includes(enrollmentToken(revoke)),
    false,
  );
  checks++;
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      native_postgres: true,
      real_auth_handlers: true,
      storage_enabled: false,
      provider_request_sent: false,
      solver_started: false,
      license_read: false,
    }),
  );
} finally {
  await db.$disconnect();
  await pool.end();
}
