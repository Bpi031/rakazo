import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { managerRole, memberScope } from "@rakazo/adapters";
import type {
  Actor,
  CallRequestDoctorView,
  CallRequestManagerView,
  CallRequestRow,
} from "@rakazo/contracts";
import {
  callDoctorBatchInput,
  callRequestEmailInput,
  callRequestInput,
  callRequestMonth,
  callRequestVerifyInput,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";

type Tx = Prisma.TransactionClient;
const MINUTE = 60_000;
export const CALL_DOCTOR_SESSION_SECONDS = 12 * 60 * 60;
const LIMIT = 5;

export async function canManageCallRequests(prisma: PrismaClient, actor: Actor): Promise<boolean> {
  try {
    const scope = await memberScope(prisma, actor.userId, actor.spaceId);
    return managerRole(scope.role);
  } catch {
    return false;
  }
}

export class CallRequestError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

function row(value: {
  id: string;
  doctorId: string;
  date: string;
  type: string;
  shift: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
  doctor: { code: string; name: string };
}): CallRequestRow {
  return {
    id: value.id,
    doctorId: value.doctorId,
    doctorCode: value.doctor.code,
    doctorName: value.doctor.name,
    date: value.date,
    type: callRequestInput.shape.type.parse(value.type),
    shift: value.shift,
    text: value.text,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

export class CallRequestService {
  private readonly deliveries = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      email?: TransactionalEmailProvider;
      secret: string;
    },
  ) {
    if (!deps.secret) throw new Error("Call request authentication secret required");
  }

  async drain() {
    while (this.deliveries.size > 0) await Promise.allSettled([...this.deliveries]);
  }

  private digest(...values: string[]) {
    return createHmac("sha256", this.deps.secret)
      .update(JSON.stringify(["call-requests/v1", ...values]))
      .digest("hex");
  }

  private async lock(tx: Tx, spaceId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`call-requests:${spaceId}`}, 0))`;
    const space = await tx.space.findUnique({
      where: { id: spaceId },
      select: { name: true, deletingAt: true },
    });
    if (!space || space.deletingAt)
      throw new CallRequestError(404, "Call requests are unavailable");
    return space;
  }

  private async manager(tx: Tx, actor: Actor) {
    if (!(await canManageCallRequests(tx as PrismaClient, actor))) {
      throw new CallRequestError(403, "Manager access required");
    }
  }

  private async doctor(tx: Tx, spaceId: string, token: string | undefined) {
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new CallRequestError(401, "Verify your email to continue");
    const session = await tx.callDoctorSession.findUnique({
      where: { tokenHash: this.digest("session", token) },
      include: { doctor: true },
    });
    if (
      !session ||
      session.spaceId !== spaceId ||
      session.expiresAt <= new Date() ||
      !session.doctor.active
    )
      throw new CallRequestError(401, "Verify your email to continue");
    return session.doctor;
  }

  async manage(actor: Actor, month: string): Promise<CallRequestManagerView> {
    callRequestMonth.parse(month);
    return this.deps.prisma.$transaction(async (tx) => {
      const space = await this.lock(tx, actor.spaceId);
      await this.manager(tx, actor);
      const doctors = await tx.callDoctor.findMany({
        where: { spaceId: actor.spaceId },
        orderBy: { code: "asc" },
      });
      const requests = await tx.callRequest.findMany({
        where: { spaceId: actor.spaceId, date: { startsWith: `${month}-` }, deletedAt: null },
        include: { doctor: { select: { code: true, name: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      });
      return {
        spaceId: actor.spaceId,
        spaceName: space.name,
        emailDelivery: Boolean(this.deps.email),
        doctors: doctors.map(({ id, code, name, email, active }) => ({
          id,
          code,
          name,
          email,
          active,
        })),
        requests: requests.map(row),
      };
    });
  }

  async upsertDoctors(actor: Actor, raw: unknown) {
    const { doctors } = callDoctorBatchInput.parse(raw);
    if (
      new Set(doctors.map((d) => d.code)).size !== doctors.length ||
      new Set(doctors.map((d) => d.email)).size !== doctors.length
    )
      throw new CallRequestError(400, "Each doctor must have a unique code and email");
    return this.deps.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor.spaceId);
      await this.manager(tx, actor);
      const existing = await tx.callDoctor.findMany({ where: { spaceId: actor.spaceId } });
      for (const input of doctors) {
        if (existing.some((d) => d.email === input.email && d.code !== input.code))
          throw new CallRequestError(409, "Email is already assigned to another doctor");
        const previous = existing.find((d) => d.code === input.code);
        if (previous && (previous.email !== input.email || !input.active)) {
          await tx.callDoctorSession.deleteMany({ where: { doctorId: previous.id } });
          // A code sent before a roster change must never authenticate the replacement identity.
          await tx.callRequestLogin.deleteMany({
            where: {
              spaceId: actor.spaceId,
              emailKey: {
                in: [this.digest("email", previous.email), this.digest("email", input.email)],
              },
            },
          });
        }
        await tx.callDoctor.upsert({
          where: { spaceId_code: { spaceId: actor.spaceId, code: input.code } },
          create: { spaceId: actor.spaceId, ...input },
          update: input,
        });
      }
      return { ok: true as const };
    });
  }

  async sendCode(spaceId: string, raw: unknown) {
    const { email } = callRequestEmailInput.parse(raw);
    if (!this.deps.email)
      throw new CallRequestError(503, "Doctor sign-in is unavailable. Contact your administrator.");
    const emailKey = this.digest("email", email);
    const now = new Date();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const codeHash = this.digest("code", spaceId, email, now.toISOString(), code);
    const deliver = await this.deps.prisma.$transaction(async (tx) => {
      await this.lock(tx, spaceId);
      // Remove expired credentials and old rate-limit slots without losing an active hourly limit.
      await tx.callRequestLogin.deleteMany({
        where: { spaceId, sentAt: { lt: new Date(now.getTime() - 60 * MINUTE) } },
      });
      await tx.callDoctorSession.deleteMany({ where: { spaceId, expiresAt: { lte: now } } });
      const previous = await tx.callRequestLogin.findUnique({
        where: { spaceId_emailKey: { spaceId, emailKey } },
      });
      const inWindow = previous && now.getTime() - previous.windowStart.getTime() < 60 * MINUTE;
      if (
        previous &&
        (now.getTime() - previous.sentAt.getTime() < MINUTE || (inWindow && previous.sends >= 5))
      )
        return false;
      const count = await tx.callRequestLogin.count({
        where: { spaceId, sentAt: { gt: new Date(now.getTime() - 60 * MINUTE) } },
      });
      if (count >= 2000) throw new CallRequestError(429, "Please try again later");
      const doctor = await tx.callDoctor.findUnique({
        where: { spaceId_email: { spaceId, email } },
      });
      await tx.callRequestLogin.upsert({
        where: { spaceId_emailKey: { spaceId, emailKey } },
        create: {
          spaceId,
          emailKey,
          codeHash: doctor?.active ? codeHash : null,
          expiresAt: new Date(now.getTime() + 10 * MINUTE),
          sentAt: now,
          windowStart: now,
          sends: 1,
        },
        update: {
          codeHash: doctor?.active ? codeHash : null,
          attempts: 0,
          sentAt: now,
          expiresAt: new Date(now.getTime() + 10 * MINUTE),
          windowStart: inWindow ? previous.windowStart : now,
          sends: inWindow ? previous.sends + 1 : 1,
        },
      });
      return Boolean(doctor?.active);
    });
    if (deliver) {
      // SMTP latency must not reveal whether an address is on the doctor roster.
      const delivery = (async () => {
        try {
          await this.deps.email!.send({
            to: email,
            subject: "Call requests verification code",
            text: `Your verification code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`,
          });
        } catch {
          await this.deps.prisma.callRequestLogin.updateMany({
            where: { spaceId, emailKey, codeHash },
            data: { codeHash: null },
          });
        }
      })();
      this.deliveries.add(delivery);
      const settled = () => this.deliveries.delete(delivery);
      // Handle both delivery and invalidation failures without an unhandled rejection.
      void delivery.then(settled, settled);
    }
    return { ok: true as const };
  }

  async verify(spaceId: string, raw: unknown) {
    const { email, code } = callRequestVerifyInput.parse(raw);
    const emailKey = this.digest("email", email);
    const token = randomBytes(32).toString("hex");
    const valid = await this.deps.prisma.$transaction(async (tx) => {
      await this.lock(tx, spaceId);
      const now = new Date();
      const login = await tx.callRequestLogin.findUnique({
        where: { spaceId_emailKey: { spaceId, emailKey } },
      });
      if (!login?.codeHash || login.expiresAt <= now || login.attempts >= 5) return false;
      const expected = this.digest("code", spaceId, email, login.sentAt.toISOString(), code);
      const matches = timingSafeEqual(
        Buffer.from(login.codeHash, "hex"),
        Buffer.from(expected, "hex"),
      );
      const doctor = await tx.callDoctor.findUnique({
        where: { spaceId_email: { spaceId, email } },
      });
      await tx.callRequestLogin.update({
        where: { spaceId_emailKey: { spaceId, emailKey } },
        data: { attempts: { increment: 1 }, ...(matches ? { codeHash: null } : {}) },
      });
      if (!matches || !doctor?.active) return false;
      await tx.callDoctorSession.create({
        data: {
          tokenHash: this.digest("session", token),
          spaceId,
          doctorId: doctor.id,
          expiresAt: new Date(now.getTime() + CALL_DOCTOR_SESSION_SECONDS * 1000),
        },
      });
      return true;
    });
    if (!valid) throw new CallRequestError(401, "Code is invalid or expired");
    return token;
  }

  async own(
    spaceId: string,
    token: string | undefined,
    month: string,
  ): Promise<CallRequestDoctorView> {
    callRequestMonth.parse(month);
    return this.deps.prisma.$transaction(async (tx) => {
      await this.lock(tx, spaceId);
      const doctor = await this.doctor(tx, spaceId, token);
      const requests = await tx.callRequest.findMany({
        where: { doctorId: doctor.id, spaceId, date: { startsWith: `${month}-` }, deletedAt: null },
        include: { doctor: { select: { code: true, name: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      });
      return {
        doctor: { id: doctor.id, code: doctor.code, name: doctor.name },
        requests: requests.map(row),
        limit: LIMIT,
      };
    });
  }

  async save(spaceId: string, token: string | undefined, raw: unknown) {
    const input = callRequestInput.parse(raw);
    return this.deps.prisma.$transaction(async (tx) => {
      await this.lock(tx, spaceId);
      const doctor = await this.doctor(tx, spaceId, token);
      const previous = input.id
        ? await tx.callRequest.findFirst({
            where: { id: input.id, doctorId: doctor.id, spaceId, deletedAt: null },
          })
        : null;
      if (input.id && !previous) throw new CallRequestError(404, "Request not found");
      const count = await tx.callRequest.count({
        where: {
          doctorId: doctor.id,
          spaceId,
          date: { startsWith: `${input.date.slice(0, 7)}-` },
          deletedAt: null,
          ...(input.id ? { id: { not: input.id } } : {}),
        },
      });
      if (count >= LIMIT)
        throw new CallRequestError(409, "A maximum of 5 requests is allowed per month");
      const { id, ...data } = input;
      if (id) await tx.callRequest.update({ where: { id }, data });
      else await tx.callRequest.create({ data: { ...data, doctorId: doctor.id, spaceId } });
      return { ok: true as const };
    });
  }

  async remove(spaceId: string, token: string | undefined, id: string) {
    return this.deps.prisma.$transaction(async (tx) => {
      await this.lock(tx, spaceId);
      const doctor = await this.doctor(tx, spaceId, token);
      const result = await tx.callRequest.updateMany({
        where: { id, spaceId, doctorId: doctor.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (!result.count) throw new CallRequestError(404, "Request not found");
      return { ok: true as const };
    });
  }

  async managerRemove(actor: Actor, id: string) {
    return this.deps.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor.spaceId);
      await this.manager(tx, actor);
      const result = await tx.callRequest.updateMany({
        where: { id, spaceId: actor.spaceId, deletedAt: null },
        data: { deletedAt: new Date(), deletedByUserId: actor.userId },
      });
      if (!result.count) throw new CallRequestError(404, "Request not found");
      return { ok: true as const };
    });
  }

  async logout(spaceId: string, token: string | undefined) {
    if (token)
      await this.deps.prisma.callDoctorSession.deleteMany({
        where: { spaceId, tokenHash: this.digest("session", token) },
      });
    return { ok: true as const };
  }
}
