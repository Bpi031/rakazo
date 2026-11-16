import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { SmtpEmailProvider } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CallRequestService } from "./call-requests.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
describePostgres("call requests (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `call-org-${suffix}`;
  const spaceId = `call-space-${suffix}`;
  const otherSpaceId = `call-other-${suffix}`;
  const ownerId = `call-owner-${suffix}`;
  const memberId = `call-member-${suffix}`;
  const owner: Actor = {
    userId: ownerId,
    spaceId,
    email: "manager@example.test",
    isDeploymentOwner: false,
  };
  const member: Actor = { ...owner, userId: memberId };
  const doctors = [
    { code: "D01", name: "Doctor One", email: "one@example.test", active: true },
    { code: "D02", name: "Doctor Two", email: "two@example.test", active: true },
  ];
  const sent: TransactionalEmail[] = [];
  const email = {
    send: async (message: TransactionalEmail) => {
      sent.push(message);
    },
  } as TransactionalEmailProvider;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let service: CallRequestService;
  const input = (day: number, extra = {}) => ({
    date: `2026-11-${String(day).padStart(2, "0")}`,
    type: "no_call",
    shift: "",
    text: "",
    ...extra,
  });
  const code = () => sent.at(-1)!.text.match(/\b\d{6}\b/)![0];
  async function login(address = doctors[0]!.email, clinic = spaceId) {
    await service.sendCode(clinic, { email: address });
    return service.verify(clinic, { email: address, code: code() });
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 10 });
    prisma = db.prisma;
    service = new CallRequestService({ prisma, email, secret: "offline-call-request-test-secret" });
    const createdAt = new Date();
    for (const id of [ownerId, memberId])
      await prisma.user.create({ data: { id, name: id, email: `${id}@example.test` } });
    await prisma.organization.create({
      data: { id: organizationId, name: "Call requests test", slug: organizationId, createdAt },
    });
    for (const id of [spaceId, otherSpaceId])
      await prisma.space.create({ data: { id, organizationId, name: "Clinic" } });
    for (const id of [ownerId, memberId]) {
      await prisma.member.create({
        data: {
          id: `member-${id}`,
          userId: id,
          organizationId,
          role: id === ownerId ? "owner" : "member",
          createdAt,
        },
      });
      for (const clinic of [spaceId, otherSpaceId])
        await prisma.spaceMember.create({
          data: { id: `${clinic}-${id}`, spaceId: clinic, organizationId, userId: id, createdAt },
        });
    }
  });
  beforeEach(async () => {
    await service.drain();
    await prisma.callDoctor.deleteMany({ where: { spaceId: { in: [spaceId, otherSpaceId] } } });
    await prisma.callRequestLogin.deleteMany({
      where: { spaceId: { in: [spaceId, otherSpaceId] } },
    });
    sent.length = 0;
    await service.upsertDoctors(owner, { doctors });
    await service.upsertDoctors({ ...owner, spaceId: otherSpaceId }, { doctors });
  });
  afterAll(async () => {
    if (!prisma) return;
    await service.drain();
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("requires an active Manager membership and never creates Rakazo doctor accounts", async () => {
    const count = await prisma.user.count();
    await expect(service.manage(member, "2026-11")).rejects.toMatchObject({ status: 403 });
    await expect(service.upsertDoctors(member, { doctors })).rejects.toMatchObject({ status: 403 });
    const view = await service.manage(owner, "2026-11");
    expect(view.doctors).toHaveLength(2);
    expect(view.emailDelivery).toBe(true);
    expect(await prisma.user.count()).toBe(count);
    await prisma.teamMemberControl.create({
      data: { organizationId, userId: ownerId, state: "suspended" },
    });
    await expect(service.manage(owner, "2026-11")).rejects.toMatchObject({ status: 403 });
    await prisma.teamMemberControl.deleteMany({ where: { organizationId } });
  });

  it("generates an expiring server code, delivers through SMTP, and verifies it once", async () => {
    let mail: { to: string; text: string } | undefined;
    const smtp = new SmtpEmailProvider(
      { url: "smtps://smtp.example.test:465", from: "no-reply@example.test" },
      {
        transport: {
          sendMail: async (message: { to: string; text: string }) => {
            mail = message;
          },
        } as never,
      },
    );
    const smtpService = new CallRequestService({
      prisma,
      email: smtp,
      secret: "offline-smtp-test-secret",
    });
    const before = Date.now();
    await smtpService.sendCode(spaceId, { email: doctors[0]!.email });
    await smtpService.drain();
    expect(mail?.to).toBe(doctors[0]!.email);
    const otp = mail!.text.match(/\b\d{6}\b/)![0];
    const login = await prisma.callRequestLogin.findFirstOrThrow({ where: { spaceId } });
    expect(login.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(login.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(login.codeHash).not.toBe(otp);
    const token = await smtpService.verify(spaceId, { email: doctors[0]!.email, code: otp });
    expect((await smtpService.own(spaceId, token, "2026-11")).doctor.code).toBe("D01");
    await expect(
      smtpService.verify(spaceId, { email: doctors[0]!.email, code: otp }),
    ).rejects.toMatchObject({ status: 401 });
    await smtp.drain();
  });

  it("directs doctors to an administrator when SMTP is not configured", async () => {
    const unavailable = new CallRequestService({ prisma, secret: "offline-smtp-test-secret" });
    await expect(unavailable.sendCode(spaceId, { email: doctors[0]!.email })).rejects.toMatchObject(
      {
        status: 503,
        message: "Doctor sign-in is unavailable. Contact your administrator.",
      },
    );
    expect(await prisma.callRequestLogin.count({ where: { spaceId } })).toBe(0);
  });

  it("does not enumerate doctor emails, throttles repeat sends, and hashes stored credentials", async () => {
    expect(await service.sendCode(spaceId, { email: "unknown@example.test" })).toEqual({
      ok: true,
    });
    expect(sent).toHaveLength(0);
    expect(await service.sendCode(spaceId, { email: doctors[0]!.email })).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const otp = code();
    const challenges = await prisma.callRequestLogin.findMany({ where: { spaceId } });
    expect(challenges.every((c) => c.emailKey.length === 64)).toBe(true);
    expect(challenges.find((c) => c.codeHash)?.codeHash).not.toBe(otp);
    await service.sendCode(spaceId, { email: doctors[0]!.email });
    expect(sent).toHaveLength(1);
    const token = await service.verify(spaceId, { email: doctors[0]!.email, code: otp });
    expect((await prisma.callDoctorSession.findFirst({ where: { spaceId } }))?.tokenHash).not.toBe(
      token,
    );
    await expect(
      service.verify(spaceId, { email: doctors[0]!.email, code: otp }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("persists failed attempts and rejects expired codes", async () => {
    await service.sendCode(spaceId, { email: doctors[0]!.email });
    const correct = code();
    const wrong = correct === "000000" ? "111111" : "000000";
    for (let n = 0; n < 5; n++)
      await expect(
        service.verify(spaceId, { email: doctors[0]!.email, code: wrong }),
      ).rejects.toMatchObject({ status: 401 });
    expect((await prisma.callRequestLogin.findFirst({ where: { spaceId } }))?.attempts).toBe(5);
    await expect(
      service.verify(spaceId, { email: doctors[0]!.email, code: correct }),
    ).rejects.toMatchObject({ status: 401 });
    await prisma.callRequestLogin.updateMany({
      where: { spaceId },
      data: { attempts: 0, expiresAt: new Date(0) },
    });
    await expect(
      service.verify(spaceId, { email: doctors[0]!.email, code: correct }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("keeps hourly send limits across service restarts and invalidates superseded codes", async () => {
    await service.sendCode(spaceId, { email: doctors[0]!.email });
    const first = code();
    await prisma.callRequestLogin.updateMany({
      where: { spaceId },
      data: { sends: 4, sentAt: new Date(Date.now() - 61_000) },
    });
    const restarted = new CallRequestService({
      prisma,
      email,
      secret: "offline-call-request-test-secret",
    });
    await restarted.sendCode(spaceId, { email: doctors[0]!.email });
    expect(sent).toHaveLength(2);
    const latest = code();
    if (latest !== first)
      await expect(
        restarted.verify(spaceId, { email: doctors[0]!.email, code: first }),
      ).rejects.toMatchObject({ status: 401 });
    await prisma.callRequestLogin.updateMany({
      where: { spaceId },
      data: { sentAt: new Date(Date.now() - 61_000) },
    });
    await restarted.sendCode(spaceId, { email: doctors[0]!.email });
    expect(sent).toHaveLength(2);
    expect((await prisma.callRequestLogin.findFirst({ where: { spaceId } }))?.sends).toBe(5);
  });

  it("invalidates pending codes across email changes and returns generic responses on delivery failure", async () => {
    await service.sendCode(spaceId, { email: doctors[0]!.email });
    const pending = code();
    await service.upsertDoctors(owner, {
      doctors: [{ ...doctors[0], email: "replacement@example.test" }],
    });
    await expect(
      service.verify(spaceId, { email: doctors[0]!.email, code: pending }),
    ).rejects.toMatchObject({ status: 401 });
    await service.sendCode(spaceId, { email: "replacement@example.test" });
    const beforeDisable = code();
    await service.upsertDoctors(owner, {
      doctors: [{ ...doctors[0], email: "replacement@example.test", active: false }],
    });
    await service.upsertDoctors(owner, {
      doctors: [{ ...doctors[0], email: "replacement@example.test", active: true }],
    });
    await expect(
      service.verify(spaceId, { email: "replacement@example.test", code: beforeDisable }),
    ).rejects.toMatchObject({ status: 401 });
    const brokenEmail = {
      send: async (message: TransactionalEmail) => {
        sent.push(message);
        throw new Error("Offline SMTP failure");
      },
    } as TransactionalEmailProvider;
    const broken = new CallRequestService({
      prisma,
      email: brokenEmail,
      secret: "offline-call-request-test-secret",
    });
    expect(await broken.sendCode(spaceId, { email: "replacement@example.test" })).toEqual({
      ok: true,
    });
    await broken.drain();
    await expect(
      broken.verify(spaceId, { email: "replacement@example.test", code: code() }),
    ).rejects.toMatchObject({ status: 401 });
    expect((await prisma.callRequestLogin.findFirst({ where: { spaceId } }))?.codeHash).toBeNull();
  });

  it("returns listed and unlisted send responses before SMTP completes and drains failed deliveries", async () => {
    let rejectDelivery!: (error: Error) => void;
    const pendingDelivery = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    const delayedEmail = {
      send: async (message: TransactionalEmail) => {
        sent.push(message);
        await pendingDelivery;
      },
    } as TransactionalEmailProvider;
    const delayed = new CallRequestService({
      prisma,
      email: delayedEmail,
      secret: "offline-call-request-test-secret",
    });
    expect(await delayed.sendCode(spaceId, { email: doctors[0]!.email })).toEqual({ ok: true });
    expect(await delayed.sendCode(spaceId, { email: "unlisted@example.test" })).toEqual({
      ok: true,
    });
    expect(sent).toHaveLength(1);
    let drained = false;
    const draining = delayed.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    rejectDelivery(new Error("Offline delayed delivery failure"));
    await draining;
    expect(drained).toBe(true);
    const challenges = await prisma.callRequestLogin.findMany({ where: { spaceId } });
    expect(challenges).toHaveLength(2);
    expect(challenges.every((challenge) => challenge.codeHash === null)).toBe(true);
  });

  it("enforces doctor and space ownership for reads, edits and deletes", async () => {
    const one = await login();
    const two = await login(doctors[1]!.email);
    await service.save(spaceId, one, input(1));
    const saved = (await service.own(spaceId, one, "2026-11")).requests[0]!;
    expect((await service.own(spaceId, two, "2026-11")).requests).toEqual([]);
    await expect(service.save(spaceId, two, { ...input(2), id: saved.id })).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.remove(spaceId, two, saved.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.own(otherSpaceId, one, "2026-11")).rejects.toMatchObject({ status: 401 });
    await expect(service.own(spaceId, undefined, "2026-11")).rejects.toMatchObject({ status: 401 });
    await expect(
      service.managerRemove({ ...owner, spaceId: otherSpaceId }, saved.id),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.manage(owner, "2026-11")).requests[0]?.doctorCode).toBe("D01");
  });

  it("enforces five active requests under concurrent submissions, including month-changing edits", async () => {
    const token = await login();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => service.save(spaceId, token, input(i + 1))),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const rows = (await service.own(spaceId, token, "2026-11")).requests;
    await service.save(spaceId, token, {
      ...input(20, { type: "prefer_call", shift: "AM" }),
      id: rows[0]!.id,
    });
    expect((await service.own(spaceId, token, "2026-11")).requests).toHaveLength(5);
    await service.save(spaceId, token, input(1, { date: "2026-12-01" }));
    const december = (await service.own(spaceId, token, "2026-12")).requests[0]!;
    await expect(
      service.save(spaceId, token, { ...input(21), id: december.id }),
    ).rejects.toMatchObject({ status: 409 });
    await service.remove(spaceId, token, rows[1]!.id);
    await service.save(spaceId, token, { ...input(21), id: december.id });
    expect((await service.own(spaceId, token, "2026-11")).requests).toHaveLength(5);
  });

  it("soft-deletes Manager removals, preserving who removed the original request", async () => {
    const token = await login();
    await service.save(spaceId, token, input(1, { type: "others", text: "Use ward B" }));
    const saved = (await service.own(spaceId, token, "2026-11")).requests[0]!;
    await service.managerRemove(owner, saved.id);
    expect((await service.manage(owner, "2026-11")).requests).toEqual([]);
    expect((await service.own(spaceId, token, "2026-11")).requests).toEqual([]);
    expect(await prisma.callRequest.findUnique({ where: { id: saved.id } })).toMatchObject({
      text: "Use ward B",
      deletedByUserId: ownerId,
      deletedAt: expect.any(Date),
    });
    await expect(service.save(spaceId, token, { ...input(2), id: saved.id })).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it("revokes sessions and pending codes when an email changes or doctor is disabled", async () => {
    const token = await login();
    await service.upsertDoctors(owner, {
      doctors: [{ ...doctors[0], email: "changed@example.test" }],
    });
    await expect(service.own(spaceId, token, "2026-11")).rejects.toMatchObject({ status: 401 });
    const replacement = await login("changed@example.test");
    await service.upsertDoctors(owner, {
      doctors: [{ ...doctors[0], email: "changed@example.test", active: false }],
    });
    await expect(service.own(spaceId, replacement, "2026-11")).rejects.toMatchObject({
      status: 401,
    });
    const count = sent.length;
    await service.sendCode(spaceId, { email: "changed@example.test" });
    expect(sent).toHaveLength(count);
  });

  it("rejects duplicate roster identities transactionally and expires/logs out sessions", async () => {
    await expect(
      service.upsertDoctors(owner, { doctors: [{ ...doctors[0], code: "OTHER" }] }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.manage(owner, "2026-11")).doctors).toHaveLength(2);
    const token = await login();
    await service.logout(spaceId, token);
    await expect(service.own(spaceId, token, "2026-11")).rejects.toMatchObject({ status: 401 });
    const two = await login(doctors[1]!.email);
    await prisma.callDoctorSession.updateMany({
      where: { spaceId },
      data: { expiresAt: new Date(0) },
    });
    await expect(service.own(spaceId, two, "2026-11")).rejects.toMatchObject({ status: 401 });
  });
});
