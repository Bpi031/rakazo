import type { Hono } from "hono";
import type { Actor, AccountAdminView } from "@rakazo/contracts";
import {
  registrationSettingsInput as registrationInput,
  accountConfirmationInput as confirmationInput,
  accountProposalInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { TeamService } from "@rakazo/adapters";
import { teamActionSchema, teamDigest, memberScope, managerRole } from "@rakazo/adapters";
import { isAllowedWebOrigin } from "./web-origins.js";

const accountKinds = new Set(["invite", "invite_revoke", "member_role", "member_state"]);
const ownerRole = (role: string) => role.split(",").some((value) => value.trim() === "owner");

export class AccountAdminService {
  constructor(
    private readonly db: PrismaClient,
    private readonly team: TeamService,
    private readonly fallback: { enabled: boolean; allowlist: string[] },
    private readonly emailDelivery = false,
  ) {}

  private policy(
    settings: {
      ownerUserId: string | null;
      signupPolicyInitialized: boolean;
      signupsEnabled: boolean;
      signupAllowlist: string;
    } | null,
  ) {
    const value = settings?.signupPolicyInitialized
      ? {
          enabled: settings.signupsEnabled,
          allowlist: settings.signupAllowlist
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        }
      : this.fallback;
    return { ...value, digest: teamDigest({ owner: settings?.ownerUserId ?? null, ...value }) };
  }

  async view(actor: Actor): Promise<AccountAdminView> {
    const scope = await this.team.scope(actor, true);
    const settings = await this.db.deploymentSettings.findUnique({ where: { id: "default" } });
    const members = await this.db.member.findMany({
      where: { organizationId: scope.organizationId },
      include: { user: { select: { name: true, email: true, emailVerified: true } } },
      orderBy: { createdAt: "asc" },
      take: 201,
    });
    if (members.length > 200) throw new Error("Account page capacity exceeded");
    const controls = await this.db.teamMemberControl.findMany({
      where: { organizationId: scope.organizationId },
    });
    const invitations = await this.db.teamInvite.findMany({
      where: { organizationId: scope.organizationId },
      select: { id: true, email: true, role: true, status: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const reviews = (await this.team.proposals(actor)).filter((row) =>
      accountKinds.has(teamActionSchema.parse(row.action).kind),
    );
    const current = await this.team.scope(actor, true);
    if (current.organizationId !== scope.organizationId || current.role !== scope.role)
      throw new Error("Role changed");
    return {
      userId: actor.userId,
      organizationId: scope.organizationId,
      canAssignRoles: ownerRole(scope.role),
      registration:
        actor.isDeploymentOwner && settings?.ownerUserId === actor.userId
          ? this.policy(settings)
          : null,
      emailDelivery: this.emailDelivery,
      members: members.map((member) => ({
        userId: member.userId,
        name: member.user.name,
        email: member.user.email,
        verified: member.user.emailVerified,
        role: member.role,
        state: controls.find((c) => c.userId === member.userId)?.state ?? "active",
        protected:
          member.userId === actor.userId ||
          ownerRole(member.role) ||
            (!ownerRole(scope.role) && managerRole(member.role)),
      })),
      invitations: invitations.map((invite) => ({
        ...invite,
        expiresAt: invite.expiresAt.toISOString(),
      })),
      reviews: reviews.map((row) => ({
        id: row.id,
        action: teamActionSchema.parse(row.action),
        digest: row.digest,
        status: row.status,
        expiresAt: row.expiresAt.toISOString(),
      })),
    };
  }

  async registration(actor: Actor, raw: unknown) {
    const input = registrationInput.parse(raw);
    const originalScope = await this.team.scope(actor, true);
    if (!actor.isDeploymentOwner) throw new Error("Deployment owner required");
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"rost:registration-policy"}, 0))`;
      const settings = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
      const live = await memberScope(tx as unknown as PrismaClient, actor.userId, actor.spaceId);
      if (live.organizationId !== originalScope.organizationId || !managerRole(live.role))
        throw new Error("Manager authorization changed");
      if (settings?.ownerUserId !== actor.userId || this.policy(settings).digest !== input.digest)
        throw new Error("Registration policy changed; review again");
      const allowlist = [...new Set(input.allowlist)];
      await tx.deploymentSettings.update({
        where: { id: "default" },
        data: {
          signupsEnabled: input.enabled,
          signupAllowlist: allowlist.join(","),
          signupPolicyInitialized: true,
        },
      });
      await tx.teamAudit.create({
        data: {
          organizationId: live.organizationId,
          actorUserId: actor.userId,
          operation: "registration_policy",
          targetId: "default",
          outcome: "applied",
        },
      });
      return { ok: true };
    });
  }

  async propose(actor: Actor, raw: unknown) {
    const input = teamActionSchema.parse(accountProposalInput.parse(raw).action);
    if (!accountKinds.has(input.kind)) throw new Error("Account action required");
    return this.team.propose(actor, input, "dashboard");
  }

  async confirm(actor: Actor, raw: unknown) {
    const input = confirmationInput.parse(raw);
    const scope = await this.team.scope(actor, true);
    const row = await this.db.teamAction.findFirst({
      where: { id: input.id, organizationId: scope.organizationId, actorUserId: actor.userId },
    });
    if (
      !row ||
      !accountKinds.has(teamActionSchema.parse(row.action).kind) ||
      input.phrase !== "APPLY " + input.id
    )
      throw new Error("Exact account review required");
    return this.team.confirm(actor, input.id, input.digest);
  }
}

export function mountAccountAdmin(
  app: Hono,
  deps: {
    service: AccountAdminService;
    actor: (request: Request) => Promise<Actor | null>;
    verifyPassword: (request: Request, password: string) => Promise<boolean>;
    webOrigin: string;
    additionalWebOrigins?: readonly string[];
  },
) {
  const attempts = new Map<string, { at: number; count: number }>();
  app.all("/api/account-admin/:operation", async (c) => {
    c.header("cache-control", "no-store");
    try {
      const actor = await deps.actor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const operation = c.req.param("operation");
      if (c.req.method === "GET") {
        if (operation !== "view") return c.json({ error: "Not found" }, 404);
        return c.json(await deps.service.view(actor));
      }
      if (c.req.method !== "POST" || !["registration", "propose", "confirm"].includes(operation))
        return c.json({ error: "Not found" }, 404);
      if (
        c.req.header("authorization") ||
        !c.req.header("cookie") ||
        !isAllowedWebOrigin(c.req.header("origin"), deps) ||
        !c.req.header("content-type")?.startsWith("application/json")
      )
        return c.json({ error: "Same-origin browser session required" }, 403);
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.json({ error: "JSON body required" }, 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16_384) {
            await reader.cancel();
            return c.json({ error: "Request too large" }, 413);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // Authorize before checking a password or revealing account metadata.
      await deps.service.view(actor);
      if (operation === "propose") return c.json(await deps.service.propose(actor, body));
      const parsed =
        operation === "registration"
          ? registrationInput.parse(body)
          : confirmationInput.parse(body);
      const now = Date.now();
      for (const [key, value] of attempts) if (now - value.at >= 60_000) attempts.delete(key);
      const bucket = attempts.get(actor.userId);
      if ((bucket?.count ?? 0) >= 5 || (!bucket && attempts.size >= 1000))
        return c.json({ error: "Confirmation rate limit" }, 429);
      attempts.set(actor.userId, { at: bucket?.at ?? now, count: (bucket?.count ?? 0) + 1 });
      if (!(await deps.verifyPassword(c.req.raw, parsed.password)))
        return c.json({ error: "Current account password required" }, 403);
      if (operation === "registration")
        return c.json(await deps.service.registration(actor, parsed));
      return c.json(await deps.service.confirm(actor, parsed));
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError"))
        return c.json({ error: "Invalid account settings" }, 400);
      return c.json(
        { error: "Account operation rejected. Check your role, current review and active work." },
        409,
      );
    }
  });
}
