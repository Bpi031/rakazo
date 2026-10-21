import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const mocks = vi.hoisted(() => ({ getBot: vi.fn() }));
vi.mock("@rakazo/db", () => ({ createRepos: () => ({ getBot: mocks.getBot }) }));
import { PriorityService, prioritySchemas, priorityTools, priorityAgentResult, MAX_PRIORITY_AGENT_BYTES } from "./policy-priorities.js";
const actor = { userId: "u", spaceId: "s", email: "test@example.invalid", isDeploymentOwner: false };
const inspection = { botId: "b", policy: "workspace/case/policy.rost", workingDirectory: "workspace/case" };
let source = "a".repeat(64); let inputs: unknown[] = []; let directory: string; let service: PriorityService;
let execute: ReturnType<typeof vi.fn>; let prisma: any;
const change = [{ id: "fairness", weight: "20", priority: "high" as const }];
const computer = { id: "c", state: "running", scope: "dedicated", providerRef: "container", homeKey: "b", kind: "docker" };
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "priority-service-")); source = "a".repeat(64); inputs = [];
  mocks.getBot.mockResolvedValue({ id: "b", computerId: "c", computer });
  execute = vi.fn(async function* (_ref, request) {
    const args = JSON.parse(Buffer.from(request.argv.at(-1), "base64").toString());
    let value: any = { ...inspection, policy: args.policy ?? inspection.policy, workingDirectory: args.workingDirectory ?? inspection.workingDirectory,
      sourceSha256: source, inputs, compilerSha256: "b".repeat(64), rules: [] };
    if (args.operation === "review") value = { ...value, changes: args.changes, candidateSha256: "c".repeat(64), candidateCnlSha256: "d".repeat(64) };
    if (args.operation === "apply") {
      if (args.review.sourceSha256 !== source) throw new Error("source changed");
      value = { policyPath: "workspace/case/draft.rost", cnlPath: "workspace/case/draft.cnl", sourceSha256: "c".repeat(64) };
    }
    yield { type: "stdout", data: JSON.stringify(value) }; yield { type: "exit", code: 0 };
  });
  prisma = { run: { findUniqueOrThrow: vi.fn() }, user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ email: actor.email }) } };
  service = new PriorityService({ prisma, sandbox: { execute } as any, dataDir: directory });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.resetAllMocks(); });
async function review() { await service.inspect(actor, inspection); return service.review(actor, { ...inspection, sourceSha256: source, changes: change }); }
it("dynamically registers the agent's current source, not a TKO filename", async () => {
  expect(await service.current(actor, "b")).toMatchObject({ status: "not_registered" });
  await service.inspect(actor, inspection); source = "f".repeat(64);
  expect(await service.current(actor, "b")).toMatchObject({ sourceSha256: source, selection: null });
});
it("records an exact separate draft once and marks selection stale after an agent edit", async () => {
  const row = await review();
  const applied = await service.apply(actor, row.id, row.digest);
  expect(applied.applied).toMatchObject({ policyApprovalGranted: false, solveStarted: false, selectionKind: "draft_revision" });
  const calls = execute.mock.calls.length;
  expect(await service.apply(actor, row.id, row.digest)).toEqual(applied);
  expect(execute).toHaveBeenCalledTimes(calls);
  expect((await service.current(actor, "b")).selection?.state).toBe("pending_agent_adoption");
  source = "e".repeat(64);
  expect((await service.current(actor, "b")).selection?.state).toBe("stale");
});
it("invalidates outstanding review after input/source changes or policy re-registration", async () => {
  const row = await review(); inputs = [{ path: "workspace/data.json", sha256: "e".repeat(64) }];
  await service.current(actor, "b");
  await expect(service.apply(actor, row.id, row.digest)).rejects.toThrow("current policy changed");
});
it("exposes agent adoption only for the selected exact draft and unchanged inputs", async () => {
  const row = await review(); await service.apply(actor, row.id, row.digest); source = "c".repeat(64);
  const adopted = await service.inspect(actor, { ...inspection, policy: "workspace/case/draft.rost" });
  expect(adopted.selection?.state).toBe("adopted"); inputs = [{ path: "workspace/data.json", sha256: "f".repeat(64) }];
  expect((await service.current(actor, "b")).selection?.state).toBe("stale");
});
it("does not overlap bot reviews and releases the lock after helper failure", async () => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  execute.mockImplementationOnce(async function* () { await gate; throw new Error("synthetic failure"); });
  const first = service.inspect(actor, inspection); const failure = expect(first).rejects.toThrow("synthetic failure");
  // Observe the lock rather than depending on arbitrary sleeps.
  const base = path.join(directory, "policy-priority-reviews");
  for (let i = 0; i < 100; i++) {
    const owners = await readdir(base).catch(() => []);
    if (owners.length && (await readdir(path.join(base, owners[0]!))).some((name) => name.endsWith(".binding.lock"))) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await expect(service.inspect(actor, inspection)).rejects.toThrow("busy"); release(); await failure;
  await expect(service.inspect(actor, inspection)).resolves.toMatchObject({ policy: inspection.policy });
});
it("revalidates source through the helper even without a refresh", async () => {
  const row = await review(); source = "e".repeat(64);
  await expect(service.apply(actor, row.id, row.digest)).rejects.toThrow("source changed");
});
it("rejects another owner, an expired review, wrong digest, and a replaced computer", async () => {
  const row = await review();
  await expect(service.get({ ...actor, userId: "other" }, row.id)).rejects.toThrow();
  await expect(service.apply(actor, row.id, "0".repeat(64))).rejects.toThrow("digest");
  mocks.getBot.mockResolvedValueOnce({ computerId: "new", computer });
  await expect(service.apply(actor, row.id, row.digest)).rejects.toThrow("Computer changed");
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(row.expiresAt) + 1);
  await expect(service.apply(actor, row.id, row.digest)).rejects.toThrow("expired"); now.mockRestore();
});
it("requires a live private computer", async () => {
  mocks.getBot.mockResolvedValue({ computer: { ...computer, scope: "team" } });
  await expect(service.inspect(actor, inspection)).rejects.toThrow("private computer"); expect(execute).not.toHaveBeenCalled();
});
it("rejects protected-record tampering", async () => {
  const row = await review(); const root = path.join(directory, "policy-priority-reviews"); const [owner] = await readdir(root);
  const file = path.join(root, owner!, row.id + ".json"); const value = JSON.parse(await readFile(file, "utf8"));
  value.review.changes[0].weight = "999"; await writeFile(file, JSON.stringify(value));
  await expect(service.get(actor, row.id)).rejects.toThrow("identity or version changed");
});
it("limits agent operations to inspect/review/current, not apply or background decisions", async () => {
  prisma.run.findUniqueOrThrow.mockResolvedValue({ status: "running", trigger: "user", userId: "u", spaceId: "s", botId: "b" });
  await expect(service.agent("run", { operation: "apply" })).rejects.toThrow("never apply");
  prisma.run.findUniqueOrThrow.mockResolvedValue({ status: "running", trigger: "schedule", userId: "u", spaceId: "s", botId: "b" });
  await expect(service.agent("run", { operation: "inspect", ...inspection })).rejects.toThrow("direct owned");
  expect(priorityTools[0]!.inputSchema.properties.operation.enum).not.toContain("apply");
});
it("bounds untrusted API fields and rejects path traversal/extra controls", () => {
  for (const policy of ["/etc/passwd", "workspace/../secret", "workspace/a\\b", "workspace/a\0b"])
    expect(() => prioritySchemas.inspect.parse({ ...inspection, policy })).toThrow();
  expect(() => prioritySchemas.review.parse({ ...inspection, sourceSha256: source, changes: change, solve: true })).toThrow();
  expect(() => prioritySchemas.review.parse({ ...inspection, sourceSha256: source, changes: [{ ...change[0], weight: "9007199254740992" }] })).toThrow();
  expect(prioritySchemas.review.parse({ ...inspection, sourceSha256: source, changes: [{ ...change[0], weight: "3915660135660" }] }).changes[0]!.weight).toBe("3915660135660");
});
it("returns a recoverable validation result for a private-home cwd without executing", async () => {
  prisma.run.findUniqueOrThrow.mockResolvedValue({ status: "running", trigger: "user", userId: "u", spaceId: "s", botId: "b" });
  const result = await service.agent("run", { operation: "inspect", policy: inspection.policy, workingDirectory: "/home/rakazo" });
  expect(result).toMatchObject({ code: "ROST_RULE_PRIORITIES_ARGUMENTS", fields: ["workingDirectory"], solveStarted: false, policyApprovalGranted: false });
  expect(result).toHaveProperty("action", expect.stringContaining("do not guess"));
  expect(execute).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
  await expect(service.agent("run", { operation: "inspect", ...inspection })).resolves.toMatchObject({ policy: inspection.policy });
});
it("rejects invalid review arguments before helper work and keeps current callable", async () => {
  prisma.run.findUniqueOrThrow.mockResolvedValue({ status: "running", trigger: "user", userId: "u", spaceId: "s", botId: "b" });
  const result = await service.agent("run", { operation: "review", ...inspection, sourceSha256: source,
    changes: [{ ...change[0], weight: "0" }] });
  expect(result).toMatchObject({ code: "ROST_RULE_PRIORITIES_ARGUMENTS", fields: ["changes"] });
  expect(execute).not.toHaveBeenCalled();
  await expect(service.agent("run", { operation: "current" })).resolves.toMatchObject({ status: "not_registered" });
});
it("accepts the workspace root but rejects home/host roots and noncanonical paths", () => {
  expect(prioritySchemas.inspect.parse({ ...inspection, workingDirectory: "workspace" }).workingDirectory).toBe("workspace");
  const field = priorityTools[0]!.inputSchema.properties.workingDirectory;
  const wire = new RegExp(field.pattern);
  for (const workingDirectory of ["/home/rakazo", "/home/rakazo/workspace/case", "/etc", ".", "workspace/..", "workspace//case", "workspace/a\nb", "workspace/a\tb", "workspace/a\\b"])
    expect(prioritySchemas.inspect.safeParse({ ...inspection, workingDirectory }).success).toBe(false);
  expect(wire.test("workspace")).toBe(true); expect(wire.test("workspace/case")).toBe(true);
  expect(wire.test("/home/rakazo")).toBe(false); expect(wire.test("workspace/a\tb")).toBe(false);
});
function largeInventory() {
  const rules = Array.from({ length: 1506 }, (_, i) => ({ id: `rule_${i}`, tier: i < 653 ? "hard" : "soft", weight: "20",
    priority: "normal", summary: "Example controlled-language statement. ".repeat(25), sourceLine: i + 1, locked: i < 653, groupId: "business" }));
  return { ...inspection, status: "current", sourceSha256: source, compilerSha256: "b".repeat(64), inputs: [],
    cnl: "Controlled language evidence.\n".repeat(30000), rules,
    groups: [{ id: "business", label: "Business examples", description: "Synthetic only", ruleIds: rules.map((r) => r.id) }],
    selection: { state: "pending_agent_adoption", policyPath: "workspace/case/draft.rost", sourceSha256: "c".repeat(64),
      baselineInputs: Array.from({ length: 2000 }, () => ({ path: "not-for-model", sha256: source })),
      policyApprovalGranted: false, solveStarted: false } };
}
it("keeps a business-size policy receipt below the agent cap without losing draft state", () => {
  const value = largeInventory(); expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(1048576);
  const result = priorityAgentResult(value);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_PRIORITY_AGENT_BYTES);
  expect(result.ruleCounts).toEqual({ total: 1506, hard: 653, soft: 853 });
  expect(result.selection).toMatchObject({ state: "pending_agent_adoption", policyPath: "workspace/case/draft.rost" });
  expect(result.selection).not.toHaveProperty("baselineInputs");
  expect(result).not.toHaveProperty("cnl"); expect(result).not.toHaveProperty("rules");
  expect(result.cnlSha256).toMatch(/^[a-f0-9]{64}$/); expect(value.rules).toHaveLength(1506);
});
it("paginates every exact rule without drops, duplication or transport expansion", () => {
  const value = largeInventory(); const ids = []; let offset: number | null = 0; const snapshotSha256 = priorityAgentResult(value).snapshotSha256;
  while (offset !== null) {
    const page = priorityAgentResult(value, { section: "rules", sourceSha256: source, snapshotSha256, offset, limit: 25, groupId: "business" });
    expect(page.error).toBeUndefined(); expect(page.rows.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MAX_PRIORITY_AGENT_BYTES);
    // This is the actual double-encoded dynamic-tool response shape.
    expect(Buffer.byteLength(JSON.stringify({ id: 1, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(page) }] } }))).toBeLessThan(1048576);
    ids.push(...page.rows.map((r: any) => r.id)); offset = page.nextOffset;
  }
  expect(ids).toEqual(value.rules.map((r) => r.id));
  const groups = priorityAgentResult(value, { section: "groups", sourceSha256: source, snapshotSha256, offset: 0, limit: 20 });
  expect(groups.rows[0]).toMatchObject({ id: "business", ruleCount: 1506 });
  expect(groups.rows[0]).not.toHaveProperty("ruleIds");
});
it("bounds UTF-8 pages and rejects mixing revisions or unknown groups", () => {
  const value = largeInventory(); value.rules = value.rules.slice(0, 25).map((r) => ({ ...r, summary: "\u6f22".repeat(1200) }));
  const snapshotSha256 = priorityAgentResult(value).snapshotSha256;
  const page = priorityAgentResult(value, { section: "rules", sourceSha256: source, snapshotSha256, offset: 0, limit: 25 });
  expect(page.rows.length).toBeLessThan(25); expect(page.nextOffset).toBe(page.rows.length);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MAX_PRIORITY_AGENT_BYTES);
  expect(priorityAgentResult(value, { section: "rules", sourceSha256: "f".repeat(64), snapshotSha256, offset: 0, limit: 20 }).code).toBe("ROST_RULE_PRIORITIES_SOURCE_CHANGED");
  expect(priorityAgentResult(value, { section: "rules", sourceSha256: source, snapshotSha256, groupId: "unknown", offset: 0, limit: 20 }).code).toBe("ROST_RULE_PRIORITIES_ARGUMENTS");
  expect(priorityAgentResult({ ...value, inputs: [{ path: "workspace/staff.json", sha256: "f".repeat(64) }] },
    { section: "rules", sourceSha256: source, snapshotSha256, offset: 0, limit: 20 }).code).toBe("ROST_RULE_PRIORITIES_SOURCE_CHANGED");
});
it("leaves full protected review evidence out of the model response while retaining the exact card id", () => {
  const result = priorityAgentResult({ id: "review", botId: "b", digest: source,
    review: { beforeCnl: "large".repeat(300000), afterCnl: "large".repeat(300000), changes: change },
    applied: null });
  expect(result).toMatchObject({ id: "review", digest: source, changesCount: 1, reviewInline: false });
  expect(result).not.toHaveProperty("review"); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2000);
});
it("projects a real service current call while leaving browser evidence complete", async () => {
  prisma.run.findUniqueOrThrow.mockResolvedValue({ status: "running", trigger: "user", userId: "u", spaceId: "s", botId: "b" });
  await service.inspect(actor, inspection);
  const value = largeInventory();
  execute.mockImplementation(async function* () {
    yield { type: "stdout", data: JSON.stringify(value) }; yield { type: "exit", code: 0 };
  });
  const result = await service.agent("run", { operation: "current" });
  expect(result).toMatchObject({ status: "current", ruleCounts: { total: 1506 } });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_PRIORITY_AGENT_BYTES);
  const browser = await service.current(actor, "b");
  expect(browser).toMatchObject({ cnl: value.cnl });
  expect(browser).toHaveProperty("rules", value.rules);
});
