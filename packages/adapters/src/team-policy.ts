import { createHash } from "node:crypto";
import { z } from "zod";

export const DEFAULT_MEMBER_BYTES = 50_000_000_000;
export const teamEnabled = () => process.env.TEAM_MANAGEMENT_ENABLED === "1";
export const teamMessagingEnabled = () => teamEnabled() || process.env.TEAM_MESSAGING_ENABLED === "1";
export const managerRole = (role: string) => role.split(",").some((item) => ["owner", "admin"].includes(item.trim()));
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const teamActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot_create"), userId: id, spaceId: id, name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ kind: z.enum(["bot_archive", "bot_restore", "bot_delete"]), botId: id }).strict(),
  z.object({ kind: z.literal("member_state"), userId: id, state: z.enum(["active", "suspended", "archived", "removed"]) }).strict(),
  z.object({ kind: z.literal("member_role"), userId: id, role: z.enum(["member", "admin"]) }).strict(),
  z.object({ kind: z.literal("invite_revoke"), inviteId: id }).strict(),
  z.object({ kind: z.literal("quota"), userId: id, bytes: z.number().int().min(1048576).max(1_000_000_000_000).multipleOf(512) }).strict(),
  z.object({ kind: z.literal("invite"), email: z.email().max(254).transform((x) => x.toLowerCase()), role: z.enum(["member", "admin"]) }).strict(),
]);
export type TeamActionInput = z.infer<typeof teamActionSchema>;
export const teamHttpSchemas = {
  propose: z.object({ action: teamActionSchema }).strict(),
  request: z.object({ botId: id, recipientUserId: id, recipientBotId: id.optional(), message: z.string().min(1).max(8000), key: z.string() }).strict(),
  acceptInvite: z.object({ token: z.string() }).strict(),
  confirm: z.object({ id, digest: z.string().regex(/^[a-f0-9]{64}$/), password: z.string(), phrase: z.string() }).strict(),
  decide: z.object({ id, accept: z.boolean(), botId: id.optional(), password: z.string() }).strict(),
};
export function teamDigest(value: unknown) {
  // PostgreSQL JSONB may reorder keys; approval identity must not depend on insertion order.
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, child]) => [name, canonical(child)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function aggregateUsage(rows: Array<{ inputTokens: number | null; outputTokens: number | null; costUsd: number | null }>) {
  const sum = (key: "inputTokens" | "outputTokens" | "costUsd") =>
    rows.every((row) => row[key] !== null && Number.isFinite(row[key]))
      ? rows.reduce((total, row) => total + row[key]!, 0) : null;
  return { calls: rows.length, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
    costUsd: sum("costUsd"), unknownCostCalls: rows.filter((row) => row.costUsd === null).length };
}

export const teamTools = [{
  name: "team_management",
  description: "Read team resource metadata or propose an exact administrative action for human review in Team settings. Never confirms or applies an action. Private chats/files are not available. Only live organization managers may read all-member metrics or propose changes. For a cross-user request use operation=request; the recipient must explicitly accept before a bot is woken. A request grants no policy approval or solver access.",
  inputSchema: { type: "object", properties: {
    operation: { type: "string", enum: ["overview", "propose", "inbox", "request", "directory", "proposal_status"] },
    action: z.toJSONSchema(teamActionSchema, { io: "input" }),
    recipient_user_id: { type: "string" }, recipient_bot_id: { type: "string" }, message: { type: "string", maxLength: 8000 },
    proposal_id: { type: "string" },
  }, required: ["operation"], additionalProperties: false },
}];
