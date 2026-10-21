import { afterEach, expect, it, vi } from "vitest";
import { workflowDefinitionSchema, workflowToolInput } from "@rakazo/contracts";
const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("./team-storage.js", () => ({ memberScope: mocks.scope }));
import { TeamWorkflowService } from "./team-workflows.js";
const actor = { userId: "manager", spaceId: "space", email: "", isDeploymentOwner: false };
export const definition = {
  name: "Department brief",
  leadBotId: "lead",
  objective: "Consolidate explicit submissions",
  modelId: "approved",
  participants: [{ botId: "peer", instruction: "Summarize the supplied information" }],
  allowParticipantStart: true,
  maxStartsPerDay: 2,
  maxOutputTokens: 512,
  grantDays: 7,
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function fixture(role = "owner") {
  vi.stubEnv("CODEX_DEPLOYMENTS", "approved");
  mocks.scope.mockResolvedValue({ organizationId: "org", role });
  const db: any = {
    bot: {
      findFirst: vi.fn(async ({ where }: any) => ({
        id: where.id,
        userId: where.id === "lead" ? "manager" : "member",
        spaceId: "space",
        name: where.id,
        thread: { id: "thread-" + where.id },
        computer: { scope: "dedicated" },
      })),
    },
    teamMemberControl: { findUnique: vi.fn(async () => null) },
    teamWorkflow: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ ...data, id: data.id, status: "draft" })),
    },
    run: {
      findUniqueOrThrow: vi.fn(async () => ({
        status: "running",
        trigger: "user",
        userId: "manager",
        spaceId: "space",
        botId: "lead",
      })),
    },
  };
  const jobs = { enqueue: vi.fn() };
  return { db, jobs, service: new TeamWorkflowService(db, jobs) };
}
it("drafts exact scoped grants without waking a bot", async () => {
  const f = fixture();
  const result = await f.service.propose(actor, definition);
  expect(result.status).toBe("draft");
  expect(result.reviewUrl).toContain("?workflows=");
  expect(f.jobs.enqueue).not.toHaveBeenCalled();
  expect(f.db.teamWorkflow.create.mock.calls[0][0].data.bindings).toHaveLength(2);
});
it("does not let a member grant authority or configure a lead", async () => {
  const f = fixture("member");
  await expect(f.service.propose(actor, definition)).rejects.toThrow();
  expect(f.db.teamWorkflow.create).not.toHaveBeenCalled();
});
it("rejects shared computers, missing bots and foreign-owned lead bots", async () => {
  const f = fixture();
  for (const bot of [
    null,
    { userId: "other", spaceId: "space", thread: { id: "t" } },
    { userId: "manager", spaceId: "space", thread: { id: "t" }, computer: { scope: "team" } },
  ]) {
    f.db.bot.findFirst.mockResolvedValue(bot);
    await expect(f.service.propose(actor, definition)).rejects.toThrow();
  }
  expect(f.db.teamWorkflow.create).not.toHaveBeenCalled();
});
it("rejects an unapproved model instead of silently choosing another", async () => {
  const f = fixture();
  await expect(f.service.propose(actor, { ...definition, modelId: "other" })).rejects.toThrow(
    "approved",
  );
});
it.each(["bot_message", "routine", "team_workflow", "webhook"])(
  "an inbound %s cannot configure, submit or self-escalate",
  async (trigger) => {
    const f = fixture();
    f.db.run.findUniqueOrThrow.mockResolvedValue({
      status: "running",
      trigger,
      userId: "manager",
      spaceId: "space",
    });
    await expect(f.service.agent("r", "key", { operation: "propose", definition })).rejects.toThrow(
      "direct human",
    );
  },
);
it.each([
  { participants: [] },
  { participants: [{ botId: "lead", instruction: "x" }] },
  { grantDays: 0 },
  { grantDays: 31 },
  { maxStartsPerDay: 0 },
  { maxStartsPerDay: 21 },
  { maxOutputTokens: 100000 },
  { maxOutputTokens: 0 },
  { shell: "rm -rf /" },
  { privateFiles: true },
  { policyApproval: true },
  { leadBotId: "../other" },
  { objective: "x".repeat(2001) },
  { participants: Array.from({ length: 9 }, (_, i) => ({ botId: "b" + i, instruction: "x" })) },
])("refuses unbounded or injected grant %j", (change) =>
  expect(workflowDefinitionSchema.safeParse({ ...definition, ...change }).success).toBe(false),
);
it("agents have no enable, consent or approval operation", () => {
  for (const operation of ["enable", "consent", "approve", "decide", "confirm"])
    expect(workflowToolInput.safeParse({ operation }).success).toBe(false);
});
