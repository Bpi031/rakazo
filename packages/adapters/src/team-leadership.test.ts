import { expect, it, vi } from "vitest";
import { leadershipDecision, leadershipProposal, leadershipToolInput } from "@rakazo/contracts";
import { TeamLeadershipService } from "./team-leadership.js";
it("an agent cannot confirm or accept a handover", () => {
  for (const operation of ["offer", "accept", "decline", "cancel", "confirm"])
    expect(leadershipToolInput.safeParse({ operation }).success).toBe(false);
});
it.each([
  { successorBotId: "../private", workflowIds: [] },
  { successorBotId: "b", workflowIds: Array(21).fill("f") },
  { successorBotId: "b", workflowIds: [], transferFiles: true },
  { successorBotId: "b", workflowIds: [], transferLicense: true },
  { successorBotId: "b", workflowIds: [], role: "owner" },
])("refuses extra privileges and data transfer %j", (value) => {
  expect(leadershipProposal.safeParse(value).success).toBe(false);
});
it("requires a digest, bounded password and exact operation for browser decisions", () => {
  expect(
    leadershipDecision.safeParse({
      id: "f",
      digest: "d".repeat(64),
      password: "correct",
      operation: "accept",
    }).success,
  ).toBe(true);
  for (const value of [
    { id: "f", operation: "accept" },
    { id: "f", digest: "wrong", password: "correct", operation: "accept" },
  ])
    expect(leadershipDecision.safeParse(value).success).toBe(false);
});
it.each(["bot_message", "routine", "team_workflow", "webhook"])(
  "cannot turn %s into a leadership offer",
  async (trigger) => {
    const db: any = {
      run: { findUniqueOrThrow: vi.fn(async () => ({ status: "running", trigger })) },
    };
    await expect(
      new TeamLeadershipService(db).agent("r", "k", {
        operation: "propose",
        proposal: { successorBotId: "peer", workflowIds: [] },
      }),
    ).rejects.toThrow("direct manager");
  },
);
