import { expect, it } from "vitest";
import { AgentStatusBlock } from "@rakazo/contracts";
import { reduceLiveMessageBlocks, updateAgentStatusBlocks } from "./events.js";

it("merges plan, usage and command status without replacing pending narration", () => {
  let blocks = reduceLiveMessageBlocks([], {
    type: "progress",
    payload: { delta: "Preparing the " },
  });
  blocks = reduceLiveMessageBlocks(blocks, {
    type: "progress",
    payload: { agentStatus: { plan: [{ step: "Export", status: "pending" }] } },
  });
  blocks = updateAgentStatusBlocks(blocks, {
    activity: { kind: "command", status: "completed", durationMs: 10 },
  });
  blocks = updateAgentStatusBlocks(blocks, { configuration: { model: "approved", effort: "high" } });
  blocks = reduceLiveMessageBlocks(blocks, { type: "progress", payload: { delta: "workbook." } });
  expect(blocks.filter((b) => b.kind === "agent_status")).toHaveLength(1);
  expect(blocks.find((b) => b.kind === "agent_status")).toMatchObject({
    plan: [{ status: "pending" }],
    activity: { status: "completed" },
    configuration: { model: "approved", effort: "high" },
  });
  expect(
    blocks
      .filter((b) => b.kind === "text" || b.kind === "progress")
      .map((b) => b.text)
      .join(""),
  ).toBe("Preparing the workbook.");
});
it("rejects invalid counters and never marks a reported unfinished plan complete", () => {
  const blocks = updateAgentStatusBlocks([], {
    plan: [{ step: "Validate", status: "inProgress" }],
  });
  expect(
    updateAgentStatusBlocks(blocks, {
      activity: { kind: "command", status: "completed", durationMs: -1 },
    }),
  ).toEqual(blocks);
  expect(
    AgentStatusBlock.safeParse({ kind: "agent_status", usage: { inputTokens: NaN } }).success,
  ).toBe(false);
  expect(blocks[0]).toMatchObject({ plan: [{ status: "inProgress" }] });
});
