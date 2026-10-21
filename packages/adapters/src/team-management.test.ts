import { describe, expect, it, vi, afterEach } from "vitest";
import { managerRole, teamActionSchema, teamDigest, aggregateUsage, teamTools } from "./team-policy.js";
import { memberScope, memberStorageKey, managerComputerEligible } from "./team-storage.js";
import { TeamService } from "./team-service.js";

afterEach(() => vi.unstubAllEnvs());
const actor = { userId: "alice", spaceId: "space", email: "a@example.com", isDeploymentOwner: false };
function fixture(role = "owner", state = "active") {
  const db: any = { spaceMember: { findUnique: vi.fn(async () => ({ organizationId: "team", member: { role } })) },
    teamMemberControl: { findUnique: vi.fn(async () => ({ state, version: 1 })) },
    member: { findUnique: vi.fn(async () => ({ userId: "bob", role: "member" })) },
    bot: { findFirst: vi.fn(async () => null) }, teamAction: { count: vi.fn(async () => 0), create: vi.fn(async (input) => ({ id: "proposal", ...input.data })), findFirst: vi.fn() },
    run: { findUniqueOrThrow: vi.fn() }, user: { findUniqueOrThrow: vi.fn(async () => ({ email: actor.email })) } };
  return { db, service: new TeamService({ prisma: db } as any) };
}
describe("team authorization and approval", () => {
  it.each(["owner", "admin", "member,admin", " admin "])("recognizes live manager %s", (role) => expect(managerRole(role)).toBe(true));
  it.each(["member", "space_owner", "superadmin", ""]) ("does not infer manager from %s", (role) => expect(managerRole(role)).toBe(false));
  it("binds JSONB approval to canonical keys and nested values", () => {
    expect(teamDigest({ a: { y: 2, x: 1 }, b: 3 })).toBe(teamDigest({ b: 3, a: { x: 1, y: 2 } }));
    expect(teamDigest([1, 2])).not.toBe(teamDigest([2, 1]));
  });
  it("rejects extra privileges and non-finite/unlimited quotas", () => {
    for (const bytes of [0, -1, Infinity, NaN, 50_000_000_001]) expect(teamActionSchema.safeParse({ kind: "quota", userId: "u", bytes }).success).toBe(false);
    expect(teamActionSchema.safeParse({ kind: "bot_create", userId: "u", spaceId: "s", name: "N", role: "manager" }).success).toBe(false);
  });
  it("never converts missing costs into zero", () => {
    expect(aggregateUsage([{ inputTokens: 1, outputTokens: 2, costUsd: null }])).toMatchObject({ costUsd: null, unknownCostCalls: 1 });
    expect(aggregateUsage([]).costUsd).toBe(0);
  });
  it("storage keys isolate ambiguous IDs and teams", () => {
    expect(memberStorageKey("ab", "c")).not.toBe(memberStorageKey("a", "bc"));
    expect(memberStorageKey("team", "alice")).not.toBe(memberStorageKey("other", "alice"));
  });
  it("personal organization ownership does not grant the operator's solver license", async () => {
    const db: any = { deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "operator" })) }, member: { findUnique: vi.fn(async () => null) } };
    expect(await managerComputerEligible(db, { organizationId: "personal", role: "owner" }, "operator")).toBe(false);
    db.member.findUnique.mockResolvedValue({ role: "owner" });
    expect(await managerComputerEligible(db, { organizationId: "operator-team", role: "member" }, "operator")).toBe(false);
    expect(await managerComputerEligible(db, { organizationId: "operator-team", role: "admin" }, "other-admin")).toBe(false);
    expect(await managerComputerEligible(db, { organizationId: "operator-team", role: "owner" }, "operator")).toBe(true);
    vi.stubEnv("ROST_SOLVER_USER_IDS", "granted-admin");
    expect(await managerComputerEligible(db, { organizationId: "operator-team", role: "admin" }, "granted-admin")).toBe(true);
    db.deploymentSettings.findUnique.mockResolvedValue(null);
    expect(await managerComputerEligible(db, { organizationId: "operator-team", role: "owner" })).toBe(false);
  });
  it.each(["suspended", "archived", "removed"])("rejects inactive account %s", async (state) => {
    const { db } = fixture("owner", state); await expect(memberScope(db, "alice", "space")).rejects.toThrow("not active");
  });
  it("rejects member administration and cross-team bots before mutation", async () => {
    const member = fixture("member"); await expect(member.service.propose(actor, { kind: "bot_delete", botId: "x" }, "agent")).rejects.toThrow("manager");
    const owner = fixture(); await expect(owner.service.propose(actor, { kind: "bot_delete", botId: "foreign" }, "agent")).rejects.toThrow("not in this team");
    expect(owner.db.teamAction.create).not.toHaveBeenCalled();
  });
  it("agent tools cannot confirm an administrative action", async () => {
    const { db, service } = fixture();
    db.run.findUniqueOrThrow.mockResolvedValue({ status: "running", userId: "alice", spaceId: "space", botId: "bot", trigger: "user" });
    await expect(service.agent("run", "op", { operation: "confirm" })).rejects.toThrow("cannot confirm");
    expect(JSON.stringify(teamTools)).not.toContain('"enum":["confirm"');
  });
  it("accepted bot requests cannot become manager administrative turns", async () => {
    const { db, service } = fixture();
    db.run.findUniqueOrThrow.mockResolvedValue({ status: "running", userId: "alice", spaceId: "space", botId: "bot", trigger: "bot_message" });
    await expect(service.agent("run", "op", { operation: "propose", action: { kind: "invite", email: "x@example.com", role: "admin" } })).rejects.toThrow("direct owner turn");
  });
  it("self suspension and admin escalation invitations fail closed", async () => {
    await expect(fixture().service.propose(actor, { kind: "member_state", userId: "alice", state: "suspended" }, "dashboard")).rejects.toThrow("Self");
    await expect(fixture("admin").service.propose(actor, { kind: "invite", email: "x@example.com", role: "admin" }, "agent")).rejects.toThrow("owner");
  });
  it("owners and self accounts cannot be demoted or disabled; admins cannot manage managers", async () => {
    const f = fixture();
    f.db.member.findUnique.mockResolvedValue({ userId: "bob", role: "owner" });
    for (const action of [{ kind: "member_state", userId: "bob", state: "suspended" }, { kind: "member_role", userId: "bob", role: "member" }])
      await expect(f.service.propose(actor, action, "dashboard")).rejects.toThrow("protected");
    await expect(f.service.propose(actor, { kind: "member_role", userId: "alice", role: "member" }, "dashboard")).rejects.toThrow("Self");
    const admin = fixture("admin"); admin.db.member.findUnique.mockResolvedValue({ userId: "bob", role: "admin" });
    await expect(admin.service.propose(actor, { kind: "member_state", userId: "bob", state: "suspended" }, "dashboard")).rejects.toThrow("owner");
    await expect(admin.service.propose(actor, { kind: "member_role", userId: "bob", role: "member" }, "dashboard")).rejects.toThrow("owner");
    expect(f.db.teamAction.create).not.toHaveBeenCalled(); expect(admin.db.teamAction.create).not.toHaveBeenCalled();
  });
  it("a role change is reviewed, audited and never archives or starts bots", async () => {
    const { db, service } = fixture();
    db.$transaction = async (work: any) => work(db); db.$executeRaw = vi.fn();
    db.teamAction.updateMany = vi.fn(async () => ({ count: 1 })); db.teamAction.update = vi.fn();
    db.member.updateMany = vi.fn(async () => ({ count: 1 })); db.bot.findMany = vi.fn(async () => []);
    db.run.count = vi.fn(async () => 0); db.teamAudit = { create: vi.fn() };
    const proposal = await service.propose(actor, { kind: "member_role", userId: "bob", role: "admin" }, "dashboard");
    const row = { ...db.teamAction.create.mock.calls[0][0].data, id: proposal.id, status: "pending" };
    db.teamAction.findFirst.mockResolvedValue(row);
    expect(await service.confirm(actor, proposal.id, proposal.digest)).toMatchObject({ status: "applied" });
    expect(db.member.updateMany).toHaveBeenCalledWith({ where: { organizationId: "team", userId: "bob", role: "member" }, data: { role: "admin" } });
    expect(db.bot.findMany).toHaveBeenCalledTimes(1);
    expect(db.teamAudit.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ operation: "member_role" }) }));
  });
  it("another executing administrative action prevents overlapping claims", async () => {
    const { db, service } = fixture();
    db.$transaction = async (work: any) => work(db); db.$executeRaw = vi.fn();
    const proposal = await service.propose(actor, { kind: "member_role", userId: "bob", role: "admin" }, "dashboard");
    db.teamAction.findFirst.mockResolvedValue({ ...db.teamAction.create.mock.calls[0][0].data, id: proposal.id, status: "pending" });
    db.teamAction.count.mockResolvedValue(1); db.teamAction.updateMany = vi.fn();
    await expect(service.confirm(actor, proposal.id, proposal.digest)).rejects.toThrow("executing");
    expect(db.teamAction.updateMany).not.toHaveBeenCalled();
  });
  it("refuses stale, missing and expired confirmations", async () => {
    const { service, db } = fixture(); db.teamAction.findFirst.mockResolvedValue(null);
    await expect(service.confirm(actor, "p", "d")).rejects.toThrow("expired");
    db.teamAction.findFirst.mockResolvedValue({ digest: "d", expiresAt: new Date(0) });
    await expect(service.confirm(actor, "p", "d")).rejects.toThrow("expired");
  });
});
