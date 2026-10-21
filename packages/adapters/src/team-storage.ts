import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { DEFAULT_MEMBER_BYTES, teamEnabled, managerRole } from "./team-policy.js";

const key = (value: string) => createHash("sha256").update(value).digest("hex");
export const memberStorageKey = (organizationId: string, userId: string) => key(JSON.stringify([organizationId, userId]));
export async function quotaCall(body: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const socketPath = process.env.TEAM_STORAGE_SOCKET;
  if (!socketPath) throw new Error("Team storage enforcement is unavailable");
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: "/v1", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      let data = "";
      response.on("data", (chunk: Buffer) => { data += chunk; if (data.length > 64 * 1024) response.destroy(new Error("storage response too large")); });
      response.on("error", reject);
      response.on("end", () => {
        try { const result = JSON.parse(data); if (response.statusCode !== 200 || result.ok !== true) throw new Error("Storage operation failed closed"); resolve(result); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Storage operation timed out")));
    request.on("error", reject); request.end(JSON.stringify(body));
  });
}

export async function memberScope(prisma: PrismaClient, userId: string, spaceId: string) {
  const membership = await prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId } }, include: { member: true } });
  if (!membership) throw new Error("Team membership required");
  const control = await prisma.teamMemberControl.findUnique({ where: { organizationId_userId: { organizationId: membership.organizationId, userId } } });
  if (control && control.state !== "active") throw new Error("Team account is not active");
  return { organizationId: membership.organizationId, role: membership.member.role, control };
}

export async function managerComputerEligible(prisma: PrismaClient, scope: { organizationId: string; role: string }, userId?: string) {
  if (!managerRole(scope.role)) return false;
  // Personal organization ownership is not authority to use the operator's license.
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" }, select: { ownerUserId: true } });
  if (!settings?.ownerUserId) return false;
  // Team leadership is not a transferable machine-license entitlement.
  const granted = (process.env.ROST_SOLVER_USER_IDS ?? "").split(",").filter(Boolean);
  if (!userId || (userId !== settings.ownerUserId && !granted.includes(userId))) return false;
  const operator = await prisma.member.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: settings.ownerUserId } }, select: { role: true } });
  return operator?.role.split(",").some((role) => role.trim() === "owner") ?? false;
}

export async function prepareMemberHome(prisma: PrismaClient, homeKey: string, context: Pick<AdapterContext, "userId" | "spaceId">) {
  if (!teamEnabled()) return;
  const scope = await memberScope(prisma, context.userId, context.spaceId);
  await quotaCall({ operation: "ensure", member: memberStorageKey(scope.organizationId, context.userId), home: homeKey,
    bytes: Number(scope.control?.quotaBytes ?? DEFAULT_MEMBER_BYTES) });
}

export function mappedHome(root: string, homeKey: string) {
  if (!teamEnabled()) return path.join(root, "homes", homeKey);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(homeKey)) throw new Error("Invalid home identity");
  const file = path.join(process.env.TEAM_STORAGE_MAPPINGS ?? "/run/rost-team-storage/mappings", key(homeKey) + ".json");
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error("Untrusted storage mapping");
  const mapping = JSON.parse(readFileSync(file, "utf8"));
  if (mapping.home !== homeKey || !/^[a-f0-9]{64}$/.test(mapping.member)) throw new Error("Invalid storage mapping");
  return path.join(root, "members", mapping.member, "homes", homeKey);
}

export async function artifactMemberRoot(prisma: PrismaClient, root: string, context: AdapterContext) {
  if (!teamEnabled()) return root;
  const scope = await memberScope(prisma, context.userId, context.spaceId);
  const member = memberStorageKey(scope.organizationId, context.userId);
  await quotaCall({ operation: "ensure", member, bytes: Number(scope.control?.quotaBytes ?? DEFAULT_MEMBER_BYTES) });
  return path.join(root, "members", member);
}
