import type { Hono } from "hono";
import type { Actor } from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "@rakazo/db";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { managerRole, memberScope, memberStorageKey, quotaCall, toComputerRef } from "@rakazo/adapters";

const identity = /^[A-Za-z0-9_-]{1,160}$/;
const fields = ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;
type Usage = { day: string; model: string; botId: string | null; calls: number; [key: string]: unknown };
export function sumUsage(rows: Usage[]) {
  return { calls: rows.reduce((n, r) => n + r.calls, 0), ...Object.fromEntries(fields.map((key) => [key,
      rows.every((r) => typeof r[key] === "number" && Number.isFinite(r[key])) ? rows.reduce((n, r) => n + Number(r[key]), 0) : null])) } as {calls:number} & Record<typeof fields[number],number|null>;
}

// Metadata only, descriptor-relative traversal. No file contents, links, caches or credentials.
export const storageProbe = String.raw`
import os, json, time, stat
end=time.monotonic()+3; remaining=25000; seen=set(); result={}
home=os.open('/home/rakazo', os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
def scan(parent, name, depth=0):
 global remaining
 total=files=0; complete=True
 try: fd=os.open(name, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=parent)
 except FileNotFoundError: return [0,0,True]
 except OSError: return [0,0,False]
 try:
  with os.scandir(fd) as entries:
   for entry in entries:
    remaining-=1
    if remaining<0 or time.monotonic()>end or depth>32: complete=False; break
    try:
     s=os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
     if stat.S_ISLNK(s.st_mode): continue
     if stat.S_ISDIR(s.st_mode):
      a,b,c=scan(fd,entry.name,depth+1); total+=a; files+=b; complete &= c
     elif stat.S_ISREG(s.st_mode) and (s.st_dev,s.st_ino) not in seen:
      seen.add((s.st_dev,s.st_ino)); total+=s.st_size; files+=1
    except OSError: complete=False
 finally: os.close(fd)
 return [total,files,complete]
for name in ['workspace','Downloads']: result[name]=scan(home,name)
os.close(home); print(json.dumps(result))
`;

export class WorkspaceInsights {
  private measurements = new Map<string, { expires: number; value: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(private db: PrismaClient, private sandbox: SandboxProvider) {}
  async scope(actor: Actor, selected?: string) {
    const scope = await memberScope(this.db, actor.userId, actor.spaceId);
    const manager = managerRole(scope.role);
    const userId = selected ?? actor.userId;
    if (!identity.test(userId) || (!manager && userId !== actor.userId)) throw new Error("Self or manager scope required");
    const member = await this.db.member.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId } },
      include: { user: { select: { name: true, email: true } } } });
    const control = await this.db.teamMemberControl.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId } } });
    if (!member || (control && control.state !== "active")) throw new Error("Active team member required");
    return { ...scope, manager, userId, name: member.user.name, control };
  }
  async people(actor: Actor) {
    const scope = await this.scope(actor);
    const rows = await this.db.member.findMany({ where: { organizationId: scope.organizationId, ...(scope.manager ? {} : { userId: actor.userId }) },
      include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: "asc" }, take: 201 });
    if (rows.length > 200) throw new Error("Member page limit reached");
    return { manager: scope.manager, userId: actor.userId, members: rows.map((r) => ({ userId: r.userId, name: r.user.name, email: r.user.email, role: r.role })) };
  }
  async usage(actor: Actor, params: URLSearchParams) {
    const scope = await this.scope(actor, params.get("userId") ?? undefined);
    const days = Number(params.get("days") ?? 30);
    if (![7, 30, 90].includes(days)) throw new Error("Invalid period");
    const botId = params.get("botId"); const model = params.get("model");
    if ((botId && !identity.test(botId)) || (model && (model.length > 128 || /[\x00-\x1f]/.test(model)))) throw new Error("Invalid filter");
    const since = new Date(); since.setUTCHours(0,0,0,0); since.setUTCDate(since.getUTCDate() - days + 1);
    // Aggregate in SQL so a busy team cannot turn the dashboard into an unbounded row download.
    const rows = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '8000', true)`;
      return tx.$queryRaw<Usage[]>(Prisma.sql`
      SELECT to_char(u."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, u.model, u."botId",
      count(*)::int AS calls,
      CASE WHEN count(u."inputTokens")=count(*) THEN sum(u."inputTokens")::float8 END AS "inputTokens",
      CASE WHEN count(u."outputTokens")=count(*) THEN sum(u."outputTokens")::float8 END AS "outputTokens",
      CASE WHEN count(u."totalTokens")=count(*) THEN sum(u."totalTokens")::float8 END AS "totalTokens",
      CASE WHEN count(u."cacheReadTokens")=count(*) THEN sum(u."cacheReadTokens")::float8 END AS "cacheReadTokens",
      CASE WHEN count(u."cacheWriteTokens")=count(*) THEN sum(u."cacheWriteTokens")::float8 END AS "cacheWriteTokens",
      CASE WHEN count(u."costUsd")=count(*) THEN sum(u."costUsd")::float8 END AS "costUsd"
      FROM usage_records u JOIN spaces s ON s.id=u."spaceId"
      WHERE s."organizationId"=${scope.organizationId} AND u."userId"=${scope.userId} AND u."createdAt">=${since}
      ${botId ? Prisma.sql`AND u."botId"=${botId}` : Prisma.empty}
      ${model ? Prisma.sql`AND u.model=${model}` : Prisma.empty}
      GROUP BY day, u.model, u."botId" ORDER BY day LIMIT 5001`);
    }, { maxWait: 2000, timeout: 10000 });
    if (rows.length > 5000) throw new Error("Usage breakdown exceeds bounded page");
    const bots = await this.db.bot.findMany({ where: { userId: scope.userId, space: { organizationId: scope.organizationId } }, select: { id: true, name: true }, take: 201 });
    await this.scope(actor, scope.userId);
    return { userId: scope.userId, name: scope.name, days, observedAt: new Date().toISOString(), since: since.toISOString(),
      timezone: "UTC", rows, totals: sumUsage(rows), bots, costKind: "reported_or_recorded_estimate" };
  }
  async storage(actor: Actor, selected?: string) {
    const scope = await this.scope(actor, selected);
    const key = scope.organizationId + ":" + scope.userId;
    const cached = this.measurements.get(key); if (cached && cached.expires > Date.now()) return cached.value;
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= 2) throw new Error("Storage measurements busy");
    const work = this.measure(actor, scope).then((value) => {
      if (this.measurements.size >= 200) this.measurements.delete(this.measurements.keys().next().value!);
      this.measurements.set(key, { value, expires: Date.now() + 60_000 }); return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, work); return work;
  }
  private async measure(actor: Actor, scope: Awaited<ReturnType<WorkspaceInsights["scope"]>>) {
    const where = { userId: scope.userId, space: { organizationId: scope.organizationId } };
    const bots = await this.db.bot.findMany({ where, include: { computer: true }, take: 65 });
    if (bots.length > 64) throw new Error("Storage bot page limit reached");
    const homes = new Set<string>(); const rows = []; const deadline = Date.now() + 10_000;
    for (const bot of bots) {
      const computer = bot.computer; let usage: Record<string, [number, number, boolean]> | null = null;
      let shared = false;
      if (computer && homes.has(computer.homeKey)) shared = true;
      else if (computer?.providerRef && computer.userId === scope.userId && computer.state === "running" && Date.now() < deadline) {
        homes.add(computer.homeKey);
        const context = { userId: scope.userId, spaceId: bot.spaceId, botId: bot.id, operationId: "storage-metadata",
          traceId: "storage-metadata", signal: AbortSignal.timeout(4500) };
        let output = ""; let code;
        try {
          for await (const event of this.sandbox.execute(toComputerRef(computer),
            { argv: ["/opt/office-python/bin/python3", "-I", "-c", storageProbe], cwd: "/home/rakazo", timeoutMs: 4000 }, context)) {
            if (event.type === "stdout") { output += event.data; if (output.length > 4096) throw new Error("Probe output limit"); }
            if (event.type === "exit") code = event.code;
          }
          const value = JSON.parse(output);
          if (code === 0 && ["workspace", "Downloads"].every((k) => Array.isArray(value[k]) && value[k].length === 3 &&
            value[k].slice(0,2).every((v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0) && typeof value[k][2] === "boolean")) usage = value;
        } catch { /* Unknown is not zero. Never provision a computer to measure it. */ }
      }
      rows.push({ botId: bot.id, name: bot.name, shared, usage });
    }
    const attachments = await this.db.artifact.aggregate({ where, _sum: { size: true }, _count: { _all: true } });
    let quota: Record<string, unknown> = { enforced: false, usedBytes: null, limitBytes: scope.control ? Number(scope.control.quotaBytes) : 50_000_000_000 };
    try { quota = await quotaCall({ operation: "status", member: memberStorageKey(scope.organizationId, scope.userId) }, 750); } catch { /* Quotas are independent of measurement. */ }
    // Membership is checked again after bounded asynchronous probes, before exposing another user's metadata.
    await this.scope(actor, scope.userId);
    return { userId: scope.userId, name: scope.name, observedAt: new Date().toISOString(), rows, quota,
      attachments: { bytes: attachments._sum.size ?? 0, files: attachments._count._all },
      scope: "Workspace and Downloads logical bytes plus published attachment metadata; excludes runtime caches, secrets and database overhead" };
  }
}

export function mountWorkspaceInsights(app: Hono, service: WorkspaceInsights, actor: (request: Request) => Promise<Actor | null>) {
  app.get("/api/workspace/:section", async (c) => {
    c.header("cache-control", "no-store");
    const current = await actor(c.req.raw); if (!current) return c.json({ error: "Sign in required" }, 401);
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((k) => !["userId","days","model","botId"].includes(k)) || [...params.keys()].some((k) => params.getAll(k).length !== 1)) return c.json({ error: "Invalid filters" }, 400);
    try {
      if (c.req.param("section") === "people") return c.json(await service.people(current));
      if (c.req.param("section") === "usage") return c.json(await service.usage(current, params));
      if (c.req.param("section") === "storage") return c.json(await service.storage(current, params.get("userId") ?? undefined));
      return c.json({ error: "Unknown section" }, 404);
    } catch { return c.json({ error: "Unavailable for this member, role or measurement window" }, 409); }
  });
}
