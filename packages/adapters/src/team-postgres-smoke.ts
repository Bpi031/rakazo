// This executable requires a disposable, migrated test database. No model or Docker calls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, createRepos } from "@rakazo/db";
import { TeamService } from "./team-service.js";

if (process.env.ROST_DISPOSABLE_TEAM_DB !== "1" || !process.env.DATABASE_URL) throw new Error("Explicit disposable database required");
process.env.TEAM_MANAGEMENT_ENABLED = "1";
const { prisma: db, pool } = createDb(process.env.DATABASE_URL);
const org = "test-" + randomUUID(); const foreign = org + "-other";
const ids = ["owner", "member", "outside", "invite"].map((name) => org + "-" + name);
const scope = (n: number) => ({ userId: ids[n]!, spaceId: org + "-space-" + n, email: ids[n] + "@example.invalid", isDeploymentOwner: false });
let checks = 0;
const jobs = { enqueue: async () => {} };
try {
  for (const [index, userId] of ids.entries()) await db.user.create({ data: { id: userId, name: "Test " + index, email: userId + "@example.invalid", emailVerified: true } });
  await db.organization.create({ data: { id: org, name: "Disposable", slug: org, createdAt: new Date() } });
  await db.organization.create({ data: { id: foreign, name: "Other", slug: foreign, createdAt: new Date() } });
  for (const n of [0, 1, 2]) {
    const organizationId = n === 2 ? foreign : org; const actor = scope(n);
    await db.member.create({ data: { id: randomUUID(), organizationId, userId: actor.userId, role: n === 1 ? "member" : "owner", createdAt: new Date() } });
    await db.space.create({ data: { id: actor.spaceId, organizationId, name: "Private", createdByUserId: actor.userId } });
    await db.spaceMember.create({ data: { id: randomUUID(), spaceId: actor.spaceId, organizationId, userId: actor.userId, role: "owner", createdAt: new Date() } });
  }
  const service = new TeamService({ prisma: db, jobs } as any);
  const proposal = await service.propose(scope(0), { kind: "invite", email: scope(3).email, role: "member" }, "agent");
  const confirmed = await service.confirm(scope(0), proposal.id, proposal.digest);
  assert.equal(confirmed.status, "applied"); checks++;
  assert.equal((await service.confirm(scope(0), proposal.id, proposal.digest)).replayed, true); checks++;
  const token = "enrollmentToken" in confirmed ? confirmed.enrollmentToken : undefined;
  assert.equal(typeof token, "string");
  assert.ok(typeof token === "string" && token.length > 0, "fresh confirmation must return an enrollment token");
  assert.equal(JSON.stringify(await service.proposals(scope(0))).includes(token), false); checks++;
  await assert.rejects(service.acceptInvite(scope(1), token)); checks++;
  const enrollment = await service.acceptInvite(scope(3), token); assert.ok(enrollment.spaceId); checks++;
  await assert.rejects(service.acceptInvite(scope(3), token)); checks++;
  await assert.rejects(service.propose(scope(1), { kind: "invite", email: "no@example.invalid", role: "admin" }, "agent")); checks++;
  const bots: Array<{ id: string }> = [];
  for (const n of [0, 1, 2]) bots.push(await createRepos(db).createBot(scope(n), { name: "Private " + n, title: "", description: "", instructions: "", notifyOnFinish: false, computerMode: "dedicated" }));
  await assert.rejects(service.propose(scope(0), { kind: "bot_delete", botId: bots[2]!.id }, "dashboard")); checks++;
  const requests = await Promise.all(Array.from({ length: 4 }, () => service.request(scope(1), bots[1]!.id, ids[0]!, "Please review a leave request; no permission implied", "same-key")));
  assert.equal(new Set(requests.map((row) => row.id)).size, 1); checks++;
  await assert.rejects(service.request(scope(1), bots[1]!.id, ids[2]!, "cross team", "other")); checks++;
  assert.equal(await db.run.count({ where: { botId: bots[0]!.id } }), 0); checks++;
  const dispatch = await service.decideRequest(scope(0), requests[0]!.id, true, bots[0]!.id);
  assert.equal(dispatch.status, "dispatched"); checks++;
  const replay = await service.decideRequest(scope(0), requests[0]!.id, true, bots[0]!.id);
  assert.equal(replay.replayed, true); assert.equal(await db.run.count({ where: { botId: bots[0]!.id } }), 1); checks++;
  const senderReplay=await service.request(scope(1),bots[1]!.id,ids[0]!,"Please review a leave request; no permission implied","same-key");
  assert.equal(senderReplay.replayed,true);assert.equal(senderReplay.id,requests[0]!.id);checks++;
  await assert.rejects(service.request(scope(1),bots[1]!.id,ids[0]!,"Please review a leave request; no permission implied","same-key",bots[0]!.id));checks++;
  const run = await db.run.findFirstOrThrow({ where: { botId: bots[0]!.id } }); assert.equal(run.trigger, "bot_message"); checks++;
  const memberView = await service.overview(scope(1)); assert.equal(memberView.members.length, 1); checks++;
  assert.equal(memberView.members[0]!.userId, ids[1]); checks++;
  await assert.rejects(service.propose(scope(0), { kind: "member_state", userId: ids[0], state: "removed" }, "dashboard")); checks++;
  const addressed = await service.request(scope(1), bots[1]!.id, ids[0]!, "Review in this exact manager bot", "targeted", bots[0]!.id);
  await assert.rejects(service.decideRequest(scope(0), addressed.id, true, "not-the-addressed-bot")); checks++;
  await assert.rejects(service.request(scope(1), bots[1]!.id, ids[0]!, "wrong target", "foreign-bot", bots[2]!.id)); checks++;
  assert.ok((await service.directory(scope(1))).find((p) => p.userId === ids[0])?.bots.some((b) => b.id === bots[0]!.id)); checks++;
  console.log(JSON.stringify({ status: "passed", checks, native_postgres: true, live_model_used: false }));
} finally {
  await db.organization.deleteMany({ where: { id: { in: [org, foreign] } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect(); await pool.end();
}
