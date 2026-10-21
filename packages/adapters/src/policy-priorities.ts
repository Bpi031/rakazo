import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, open, rename, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { SandboxProvider, AdapterContext } from "@rakazo/adapter-kit";
import { createRepos } from "@rakazo/db";
import { toComputerRef } from "./computer-support.js";
import { teamDigest } from "./team-policy.js";

const relative = z.string().max(1024).refine((value) => value.startsWith("workspace/") && !/[\\\x00-\x1f]/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Use an exact workspace-relative path");
const workingDirectory = z.union([z.literal("workspace"), relative]);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const rule = z.object({ id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), weight: z.string().regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => value.length < 16 || value <= "9007199254740991", "Exact positive safe integer required"),
  priority: z.enum(["critical", "high", "normal", "low"]) }).strict();
export const prioritySchemas = {
  inspect: z.object({ botId: z.string().min(1).max(160), policy: relative, workingDirectory }).strict(),
  review: z.object({ botId: z.string().min(1).max(160), policy: relative, workingDirectory,
    sourceSha256: hex, changes: z.array(rule).min(1).max(200) }).strict(),
  apply: z.object({ id: z.uuid(), digest: hex, password: z.string().min(1).max(1024), phrase: z.string().max(100) }).strict(),
};
const helper = readFileSync(new URL("./policy-priority-helper.py", import.meta.url), "utf8");
const helperSha256 = createHash("sha256").update(helper).digest("hex");
type Data = Record<string, any>;
export const MAX_PRIORITY_AGENT_BYTES = 48 * 1024;
const detailQuery = z.object({ section: z.enum(["groups", "rules"]), sourceSha256: hex, snapshotSha256: hex,
  offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(25).default(20),
  groupId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200).optional() }).strict();
function argumentError(fields: string[]) {
  return { code: "ROST_RULE_PRIORITIES_ARGUMENTS", error: "Invalid rule-priority tool arguments.", fields,
    action: "Use policy workspace/.../policy.rost and workingDirectory workspace or workspace/... . Absolute paths, traversal and control characters are not accepted. Preserve the actual input-resolution directory; do not guess a replacement. For an unchanged rerun use current without path arguments. For paged details use list with section and the current sourceSha256/snapshotSha256. Correct the call without duplicating numerical work; presentation registration is not a numerical readiness gate.",
    solveStarted: false, policyApprovalGranted: false };
}
function boundedAgentResult(value: Data): Data {
  if (Buffer.byteLength(JSON.stringify(value)) <= MAX_PRIORITY_AGENT_BYTES) return value;
  return { code: "ROST_RULE_PRIORITIES_RESULT_LIMIT", error: "Policy detail exceeds the finite agent result limit.",
    action: "Use a smaller detail page or inspect exact source/CNL files with bounded file tools. Do not repeat a solve or raise transport limits.",
    solveStarted: false, policyApprovalGranted: false };
}
function selectedDraft(value: Data | null | undefined) {
  if (!value) return null;
  return Object.fromEntries(["state", "reviewId", "digest", "policyPath", "cnlPath", "manifestPath", "sourceSha256",
    "selectedBy", "selectedAt", "selectionKind", "policyApprovalGranted", "solveStarted"]
    .filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}
/** Browser reviews keep full evidence; model context receives explicit bounded projections. */
export function priorityAgentResult(value: Data, query?: z.infer<typeof detailQuery>): Data {
  if (value.status === "not_registered") return { status: value.status, botId: value.botId, selection: null,
    action: "No policy is registered for this bot. Use inspect with exact workspace policy/cwd if a presentation binding is needed.",
    solveStarted: false, policyApprovalGranted: false };
  if (typeof value.id === "string") return boundedAgentResult({ id: value.id, botId: value.botId, digest: value.digest,
    createdAt: value.createdAt, expiresAt: value.expiresAt, reviewUrl: value.reviewUrl, applied: selectedDraft(value.applied),
    changesCount: value.review?.changes?.length ?? 0, reviewInline: false,
    action: "The exact protected review is in the inline chat card. Full CNL and diff remain in the browser review; no policy approval or solve is granted." });
  const rules: Data[] = Array.isArray(value.rules) ? value.rules : [];
  const groups: Data[] = Array.isArray(value.groups) ? value.groups : [];
  const summary: Data = { status: value.status ?? "inspected", policy: value.policy, workingDirectory: value.workingDirectory,
    sourceSha256: value.sourceSha256, compilerSha256: value.compilerSha256, selection: selectedDraft(value.selection),
    ruleCounts: { total: rules.length, hard: rules.filter((r) => r.tier !== "soft").length, soft: rules.filter((r) => r.tier === "soft").length },
    groupCount: groups.length, presentationStatus: value.presentationStatus, inputCount: value.inputs?.length ?? 0,
    inputsSha256: teamDigest(value.inputs ?? []), cnlSha256: typeof value.cnl === "string" ? createHash("sha256").update(value.cnl).digest("hex") : null,
    ruleDetailsInline: false, solveStarted: false, policyApprovalGranted: false,
    action: "Use list with section groups or rules, sourceSha256/snapshotSha256 and optional groupId/offset/limit for bounded details. Full CNL and review evidence are not inline; current only reconciles the registered policy." };
  summary.snapshotSha256 = teamDigest({ policy: value.policy, workingDirectory: value.workingDirectory,
    sourceSha256: value.sourceSha256, compilerSha256: value.compilerSha256, helperSha256,
    inputsSha256: summary.inputsSha256, cnlSha256: summary.cnlSha256, groupsSha256: teamDigest(groups), selection: summary.selection });
  if (!query) return boundedAgentResult(summary);
  if (value.sourceSha256 !== query.sourceSha256 || summary.snapshotSha256 !== query.snapshotSha256) return { code: "ROST_RULE_PRIORITIES_SOURCE_CHANGED",
    error: "Policy source, inputs or review context changed between detail pages.", action: "Call current and review the new context before requesting more pages. Do not combine different revisions.",
    solveStarted: false, policyApprovalGranted: false };
  if (query.groupId && (query.section !== "rules" || !groups.some((group) => group.id === query.groupId)))
    return argumentError(["groupId"]);
  const rows = query.section === "groups" ? groups.map(({ id, label, description, ruleIds }) => ({ id, label, description, ruleCount: ruleIds.length })) :
    rules.filter((r) => !query.groupId || r.groupId === query.groupId).map(({ id, tier, weight, priority, summary, sourceLine, locked, groupId }) =>
      ({ id, tier, weight, priority, summary, sourceLine, locked, groupId }));
  const result = { ...summary, ruleDetailsInline: query.section === "rules", section: query.section, groupId: query.groupId, total: rows.length,
    offset: query.offset, nextOffset: query.offset < rows.length ? query.offset : null, rows: [] as Data[] };
  for (const row of rows.slice(query.offset, query.offset + query.limit)) {
    result.rows.push(row); result.nextOffset = query.offset + result.rows.length < rows.length ? query.offset + result.rows.length : null;
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_PRIORITY_AGENT_BYTES) {
      result.rows.pop(); result.nextOffset = query.offset + result.rows.length; break;
    }
  }
  if (!result.rows.length && query.offset < rows.length) return boundedAgentResult({ ...result, error: "A detail row exceeds the finite agent limit.",
    action: "Read the exact source/CNL using bounded file tools; do not loop the same empty page." });
  return boundedAgentResult(result);
}
type Stored = { id: string; actorUserId: string; spaceId: string; botId: string; computerId: string;
  helperSha256: string; createdAt: string; expiresAt: string; review: Data; digest: string;
  bindingDigest: string; applied?: Data };

export class PriorityService {
  constructor(private readonly deps: { prisma: PrismaClient; sandbox: SandboxProvider; dataDir: string }) {}
  private async owned(actor: Actor, botId: string) {
    const bot = await createRepos(this.deps.prisma).getBot(actor, botId);
    if (!bot.computer || bot.computer.state !== "running" || !bot.computer.providerRef) throw new Error("Start the bot computer first");
    if (bot.computer.scope !== "dedicated") throw new Error("Rule review requires a dedicated private computer");
    return bot;
  }
  private async directory(actor: Actor) {
    const base = path.resolve(this.deps.dataDir, "policy-priority-reviews");
    await mkdir(base, { recursive: true, mode: 0o700 });
    if ((await lstat(base)).isSymbolicLink()) throw new Error("Invalid review storage");
    const dir = path.join(base, teamDigest({ space: actor.spaceId, user: actor.userId }));
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if ((await lstat(dir)).isSymbolicLink()) throw new Error("Invalid review storage");
    return dir;
  }
  private digest(row: Omit<Stored, "digest"> | Stored) {
    const { digest: _digest, applied: _applied, ...payload } = row as Stored;
    return teamDigest(payload);
  }
  private async binding(actor: Actor, botId: string) {
    const file = path.join(await this.directory(actor), teamDigest(botId) + ".binding.json");
    try {
      if ((await lstat(file)).isSymbolicLink()) throw new Error("Invalid binding");
      const value = JSON.parse(await readFile(file, "utf8"));
      if (value.botId !== botId) throw new Error("Invalid binding");
      return { file, value: value as Data };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, value: null }; throw error; }
  }
  private async saveBinding(file: string, value: Data) {
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, file);
  }
  private async withBotLock<T>(actor: Actor, botId: string, operation: () => Promise<T>): Promise<T> {
    const file = path.join(await this.directory(actor), teamDigest(botId) + ".binding.lock");
    const lock = await open(file, "wx", 0o600).catch(() => { throw new Error("Policy review is busy; inspect before retrying"); });
    try { return await operation(); }
    finally { await lock.close(); const { unlink } = await import("node:fs/promises"); await unlink(file); }
  }
  private bindingValue(botId: string, value: Data) {
    return { botId, policy: value.policy, workingDirectory: value.workingDirectory, sourceSha256: value.sourceSha256,
      inputs: value.inputs, compilerSha256: value.compilerSha256 };
  }
  private selection(value: Data | null, current: Data, computerId: string) {
    if (!value) return null;
    const modelInputs = (rows: Data[]) => rows.filter((row) => row.kind !== "rule_presentation");
    const sameInputs = teamDigest(modelInputs(value.baselineInputs)) === teamDigest(modelInputs(current.inputs)) && value.compilerSha256 === current.compilerSha256;
    const state = value.computerId !== computerId || !sameInputs ? "stale" :
      value.baselineDigest === teamDigest(current) ? "pending_agent_adoption" :
      value.policyPath === current.policy && value.sourceSha256 === current.sourceSha256 ? "adopted" : "stale";
    return { ...value, state };
  }
  private async execute(actor: Actor, botId: string, input: Data) {
    const bot = await this.owned(actor, botId);
    const context: AdapterContext = { userId: actor.userId, spaceId: actor.spaceId, botId,
      operationId: "priorities:" + randomUUID(), traceId: "priority-review", signal: AbortSignal.timeout(100_000) };
    const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
    if (encoded.length > 120_000) throw new Error("Review exceeds the finite transport cap");
    let stdout = ""; let status: number | undefined;
    for await (const event of this.deps.sandbox.execute(toComputerRef(bot.computer!), {
      argv: ["/opt/office-python/bin/python3", "-I", "-c", helper, encoded], cwd: "/home/rakazo", timeoutMs: 95_000,
      unsetEnv: ["PYTHONPATH", "PYTHONHOME", "LD_PRELOAD"] }, context)) {
      if (event.type === "stdout") { stdout += event.data; if (Buffer.byteLength(stdout) > 4_194_304) throw new Error("Review output cap reached"); }
      if (event.type === "exit") status = event.code;
    }
    let value: Data;
    try { value = JSON.parse(stdout); } catch { throw new Error("Rost rule review did not return a complete result"); }
    if (status !== 0 || value.error) throw new Error(typeof value.error === "string" ? value.error.slice(0,300) : "Rost rule review failed");
    return { value, computerId: bot.computerId! };
  }
  async inspect(actor: Actor, input: z.infer<typeof prioritySchemas.inspect>) {
    input = prioritySchemas.inspect.parse(input);
    return this.withBotLock(actor, input.botId, async () => {
    const { value: result, computerId } = await this.execute(actor, input.botId, { ...input, operation: "inspect" });
    const binding = await this.binding(actor, input.botId);
    const value = this.bindingValue(input.botId, result);
    const selection = this.selection(binding.value?.selection, value, computerId);
    await this.saveBinding(binding.file, { ...value, selection });
    return { ...result, selection, viewUrl: "/app/" + encodeURIComponent(input.botId) + "?rules=current" };
    });
  }
  async current(actor: Actor, botId: string) {
    await this.owned(actor, botId);
    return this.withBotLock(actor, botId, async () => {
    const binding = await this.binding(actor, botId);
    if (!binding.value) return { status: "not_registered", botId, selection: null };
    const { value, computerId } = await this.execute(actor, botId, { operation: "inspect", policy: binding.value.policy,
      workingDirectory: binding.value.workingDirectory });
    const current = this.bindingValue(botId, value);
    const selection = this.selection(binding.value.selection, current, computerId);
    await this.saveBinding(binding.file, { ...current, selection });
    return { status: "current", ...value, selection, viewUrl: "/app/" + encodeURIComponent(botId) + "?rules=current" };
    });
  }
  async review(actor: Actor, input: z.infer<typeof prioritySchemas.review>) {
    input = prioritySchemas.review.parse(input);
    return this.withBotLock(actor, input.botId, async () => {
    const { value, computerId } = await this.execute(actor, input.botId, { ...input, operation: "review" });
    const binding = await this.binding(actor, input.botId);
    const expectedBinding = this.bindingValue(input.botId, value);
    if (binding.value && teamDigest(this.bindingValue(input.botId, binding.value)) !== teamDigest(expectedBinding))
      throw new Error("The agent's current policy changed; reload the current policy");
    if (!binding.value) await this.saveBinding(binding.file, expectedBinding);
    const now = Date.now(); const id = randomUUID();
    const row: Stored = { id, actorUserId: actor.userId, spaceId: actor.spaceId, botId: input.botId, computerId,
      helperSha256, bindingDigest: teamDigest(expectedBinding), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), review: value, digest: "" };
    row.digest = this.digest(row);
    const directory = await this.directory(actor);
    const { readdir } = await import("node:fs/promises");
    if ((await readdir(directory)).filter((name) => name.endsWith(".json")).length >= 1000) throw new Error("Review archive limit reached; operator archival required");
    await writeFile(path.join(directory, id + ".json"), JSON.stringify(row), { flag: "wx", mode: 0o600 });
    return this.dto(row);
    });
  }
  private dto(row: Stored) {
    return { id: row.id, botId: row.botId, digest: row.digest, createdAt: row.createdAt, expiresAt: row.expiresAt,
      review: row.review, applied: row.applied ?? null, reviewUrl: "/app/" + encodeURIComponent(row.botId) + "?priorityReview=" + row.id };
  }
  private async load(actor: Actor, id: string) {
    z.uuid().parse(id); const file = path.join(await this.directory(actor), id + ".json");
    if ((await lstat(file)).isSymbolicLink()) throw new Error("Invalid review record");
    const raw = await readFile(file, "utf8"); if (Buffer.byteLength(raw) > 4_194_304) throw new Error("Invalid review record");
    const row = JSON.parse(raw) as Stored;
    if (row.id !== id || row.actorUserId !== actor.userId || row.spaceId !== actor.spaceId || row.digest !== this.digest(row) || row.helperSha256 !== helperSha256)
      throw new Error("Review identity or version changed");
    return { row, file };
  }
  async get(actor: Actor, id: string) { const { row } = await this.load(actor, id); await this.owned(actor, row.botId); return this.dto(row); }
  /** Called only by the reauthenticated browser boundary, never an agent tool. */
  async apply(actor: Actor, id: string, digest: string) {
    const initial = await this.load(actor, id);
    return this.withBotLock(actor, initial.row.botId, async () => {
    const { row, file } = await this.load(actor, id);
    if (row.digest !== digest) throw new Error("Review digest changed");
    const bot = await this.owned(actor, row.botId);
    if (bot.computerId !== row.computerId) throw new Error("Computer changed; obtain a fresh review");
    const binding = await this.binding(actor, row.botId);
    const selected = () => ({ reviewId: id, digest, ...row.applied, baselineDigest: row.bindingDigest,
      baselineInputs: row.review.inputs, compilerSha256: row.review.compilerSha256, computerId: row.computerId });
    if (row.applied) {
      // Reconcile a lost binding write without replacing a later human selection.
      if (binding.value && !binding.value.selection && teamDigest(this.bindingValue(row.botId, binding.value)) === row.bindingDigest)
        await this.saveBinding(binding.file, { ...binding.value, selection: selected() });
      return this.dto(row);
    }
    if (!binding.value || teamDigest(this.bindingValue(row.botId, binding.value)) !== row.bindingDigest) throw new Error("The agent's current policy changed");
    if (Date.parse(row.expiresAt) <= Date.now()) throw new Error("Review expired; obtain a fresh review");
    const lock = await open(file + ".lock", "wx", 0o600).catch(() => { throw new Error("Review is already being applied; inspect its receipt"); });
    try {
      if (Date.parse(row.expiresAt) <= Date.now()) throw new Error("Review expired");
      const pinned = Object.fromEntries(["policy", "workingDirectory", "sourceSha256", "inputs", "compilerSha256", "candidateSha256", "candidateCnlSha256", "changes"].map((key) => [key, row.review[key]]));
      const { value } = await this.execute(actor, row.botId, { operation: "apply", id, review: pinned });
      row.applied = { ...value, selectedBy: actor.userId, selectedAt: new Date().toISOString(),
        selectionKind: "draft_revision", policyApprovalGranted: false, solveStarted: false };
      const temporary = file + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify(row), { flag: "wx", mode: 0o600 }); await rename(temporary, file);
      await this.saveBinding(binding.file, { ...binding.value, selection: selected() });
      return this.dto(row);
    } finally { await lock.close(); const { unlink } = await import("node:fs/promises"); await unlink(file + ".lock"); }
    });
  }
  async agent(runId: string, args: Data) {
    const run = await this.deps.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== "running" || !["user", "follow_up"].includes(run.trigger)) throw new Error("A direct owned agent turn is required");
    const user = await this.deps.prisma.user.findUniqueOrThrow({ where: { id: run.userId } });
    const actor = { userId: run.userId, spaceId: run.spaceId, email: user.email, isDeploymentOwner: false };
    if (args.operation === "current") return priorityAgentResult(await this.current(actor, run.botId));
    if (args.operation === "list") {
      const parsed = detailQuery.safeParse(Object.fromEntries(["section", "sourceSha256", "snapshotSha256", "offset", "limit", "groupId"]
        .filter((key) => args[key] !== undefined).map((key) => [key, args[key]])));
      if (!parsed.success) return argumentError([...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "arguments")))].slice(0, 8));
      return priorityAgentResult(await this.current(actor, run.botId), parsed.data);
    }
    if (args.operation === "inspect" || args.operation === "review") {
      const input = { botId: run.botId, policy: args.policy, workingDirectory: args.workingDirectory };
      const parsed = args.operation === "inspect" ? prioritySchemas.inspect.safeParse(input) :
        prioritySchemas.review.safeParse({ ...input, sourceSha256: args.sourceSha256, changes: args.changes });
      if (!parsed.success) return argumentError([...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "arguments")))].slice(0, 8));
      if (args.operation === "inspect") return priorityAgentResult(await this.inspect(actor, parsed.data as z.infer<typeof prioritySchemas.inspect>));
      return priorityAgentResult(await this.review(actor, parsed.data as z.infer<typeof prioritySchemas.review>));
    }
    throw new Error("Agents can inspect/list/propose soft priorities, never apply them");
  }
}

export const priorityTools = [{ name: "rule_priorities", description: "Read the policy you manage or propose an exact soft-rule draft. Use inspect after authoring/checking a native .rost file to register source/cwd; use current before modeling/solving to reconcile human draft selections. For an unchanged rerun use current, not re-registration of every frozen copy. This presentation tool is not a numerical readiness gate. Summarize requested rules in chat with present_report, not a separate Rule Priorities page or raw weight controls. A review operation automatically posts an authenticated inline draft-review card. Selection grants no contract approval or solve allowance. Source-pinned .rules.json business groups and compiler CNL are display/review evidence, not approval. Never applies, disables hard rules or starts/stops a solve. Inspect/review require policy workspace/.../policy.rost and workingDirectory workspace or workspace/...; neither field accepts /home/rakazo or other absolute paths. Never change cwd merely to pass this schema.",
  inputSchema: { type: "object", properties: { operation: { type: "string", enum: ["current", "inspect", "list", "review"] },
    section: { type: "string", enum: ["groups", "rules"], description: "For list: request bounded pages pinned to sourceSha256 and snapshotSha256 from current." },
    snapshotSha256: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact current receipt snapshot digest; binds inputs, compiler, CNL and review context." },
    offset: { type: "integer", minimum: 0, maximum: 1000000 }, limit: { type: "integer", minimum: 1, maximum: 25 },
    groupId: { type: "string", maxLength: 200, description: "Optional exact business group ID for a rules page." },
    policy: { type: "string", maxLength: 1024, pattern: "^workspace/[^\\\\\\u0000-\\u001f]+$", description: "Exact policy file relative to the private home, e.g. workspace/case/policy.rost. No absolute paths or traversal." },
    workingDirectory: { type: "string", maxLength: 1024, pattern: "^workspace(?:/[^\\\\\\u0000-\\u001f]+)?$", description: "Actual input-resolution directory: workspace or workspace/case. Never /home/rakazo. For unchanged reruns prefer current without path arguments." }, sourceSha256: { type: "string" },
    changes: { type: "array", maxItems: 200, items: { type: "object", properties: { id: { type: "string" }, weight: { type: "string" },
      priority: { type: "string", enum: ["critical", "high", "normal", "low"] } }, required: ["id", "weight", "priority"], additionalProperties: false } } },
    required: ["operation"], additionalProperties: false } }];
