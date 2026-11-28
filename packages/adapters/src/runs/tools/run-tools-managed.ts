import {
  formTools,
  leadershipTools,
  nativeReadTools,
  workbenchTools,
  workflowTools,
} from "@rakazo/contracts";
import { reportTools } from "../../agent-report.js";
import { AgentWorkbench, workbenchEnabled } from "../../agent-workbench.js";
import { nativeEnabled } from "../../native-control.js";
import { PriorityService, priorityTools } from "../../policy/policy-priorities.js";
import {
  managerChatPolicy,
  PolicyWorkflow,
  policyWorkflowTools,
} from "../../policy/policy-workflow.js";
import { TeamLeadershipService } from "../../teams/team-leadership.js";
import { observeTeamComputers } from "../../teams/team-observer.js";
import { teamMessagingEnabled, teamTools } from "../../teams/team-policy.js";
import { TeamService } from "../../teams/team-service.js";
import { TeamWorkflowService } from "../../teams/team-workflows.js";
import { publishMessage } from "../assembly/run-messages.js";
import type { ToolHandler, ToolHandlers } from "./run-tool-gate.js";

const team = [...teamTools, ...workflowTools, ...leadershipTools];
const roster = [...priorityTools, ...policyWorkflowTools, ...reportTools];
export const MANAGED_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...team, ...roster, ...workbenchTools, ...formTools, ...nativeReadTools].map(({ name }) => name),
);

export function managedTools(input: { runtime: string; direct: boolean; completion: boolean }) {
  const { runtime, direct, completion } = input;
  if (!direct && !completion) return [];
  const codex = runtime === "codex";
  return [
    ...(direct && teamMessagingEnabled() ? team : []),
    ...(codex ? roster : []),
    ...(codex && direct && workbenchEnabled() ? [...workbenchTools, ...formTools] : []),
    ...(codex && direct && workbenchEnabled() && nativeEnabled() ? nativeReadTools : []),
  ];
}

function owned(handler: ToolHandler): ToolHandler {
  return async (ctx, call) => {
    if (
      !ctx.tools.offered.some(({ name }) => name === call.name) ||
      ctx.run.userId !== ctx.bot.userId ||
      (await ctx.trust.receivedOutsideMessage())
    )
      return call.finish({ error: "This action requires the bot owner's private chat." });
    return handler(ctx, call);
  };
}

export const managedToolHandlers: ToolHandlers = {
  team_management: owned(async (ctx, call) =>
    call.finish(
      await new TeamService({ ...ctx.deps, observe: observeTeamComputers }).agent(
        ctx.runId,
        call.effectKey,
        call.args,
      ),
    ),
  ),
  team_workflows: owned(async (ctx, call) =>
    call.finish(
      await new TeamWorkflowService(ctx.deps.prisma, ctx.deps.jobs).agent(
        ctx.runId,
        call.effectKey,
        call.args,
      ),
    ),
  ),
  team_leadership: owned(async (ctx, call) =>
    call.finish(
      await new TeamLeadershipService(ctx.deps.prisma).agent(ctx.runId, call.effectKey, call.args),
    ),
  ),
  workspace_control: owned(async (ctx, call) =>
    call.finish(
      await new AgentWorkbench({ prisma: ctx.deps.prisma, sandbox: ctx.deps.sandbox }).agent(
        ctx.runId,
        call.effectKey,
        call.args,
      ),
    ),
  ),
  rule_priorities: owned(async (ctx, call) => {
    const { deps, run } = ctx;
    const result = await new PriorityService({
      prisma: deps.prisma,
      sandbox: deps.sandbox,
      dataDir: deps.dataDir ?? "/data",
    }).agent(run.id, call.args);
    if (call.args.operation === "review" && "id" in result && typeof result.id === "string") {
      const message = await publishMessage(
        deps,
        run,
        "bot",
        [{ kind: "policy_review", reviewId: result.id, botId: run.botId }],
        undefined,
        `policy-review:${call.effectKey}`,
      );
      if (message) ctx.state.reply.publishedMidTurnUserMessage = true;
    }
    return call.finish(result);
  }),
  policy_workflow: owned(async (ctx, call) => {
    const { deps, run } = ctx;
    const result = await new PolicyWorkflow({ prisma: deps.prisma, sandbox: deps.sandbox }).agent(
      run.id,
      call.effectKey,
      call.args,
    );
    if (
      !managerChatPolicy() &&
      ["review", "amendment_review", "relaxation_review"].includes(String(call.args.operation)) &&
      "id" in result &&
      typeof result.id === "string" &&
      "status" in result &&
      result.status === "pending"
    ) {
      const message = await publishMessage(
        deps,
        run,
        "bot",
        [{ kind: "policy_approval", reviewId: result.id, botId: run.botId }],
        undefined,
        `policy-owner:${call.effectKey}`,
      );
      if (message) ctx.state.reply.publishedMidTurnUserMessage = true;
    }
    return call.finish(result);
  }),
};
