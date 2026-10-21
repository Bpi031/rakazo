import { CodexProtocolRuntime, runtimeConfig } from "./codex-protocol.mjs";
import { nativeReadTools } from "@rakazo/contracts";
import { AgentWorkbench } from "./agent-workbench.js";
import { NativeControl } from "./native-control.js";
import { teamDigest } from "./team-policy.js";
import type { PrismaClient } from "@rakazo/db";
import type { AdapterContext, SandboxProvider, RuntimeSessionRequest } from "@rakazo/adapter-kit";

export async function nativeHelper(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  runId: string,
  executionId: string,
  args: Record<string, unknown>,
  open: (request: RuntimeSessionRequest) => Promise<any>,
  context: AdapterContext,
) {
  const control = new NativeControl(deps.prisma, deps.sandbox);
  const { actor, run } = await control.actor(runId);
  const key = teamDigest({
    userId: actor.userId,
    spaceId: actor.spaceId,
    botId: run.botId,
    kind: "native_session",
  });
  const helper = new AgentWorkbench({
    prisma: deps.prisma,
    helperAuthority: "native_read_only_worker",
    generate: async (input) => {
      const runtime = new CodexProtocolRuntime(runtimeConfig());
      let text = "",
        usage: any;
      const signal = AbortSignal.any([
        ...(context.signal ? [context.signal] : []),
        AbortSignal.timeout(90000),
      ]);
      let calls = 0;
      for await (const event of runtime.run(
        {
          runId,
          botId: run.botId,
          threadId: run.threadId,
          prompt: input.message,
          instructions:
            "You are an isolated read-only native Codex worker. Analyze the explicit task using bounded workspace_read/workspace_list only. No shell, writes, other members, approval, solver work or nested agents. Return concise findings and uncertainty. " +
            input.instruction,
          history: [],
          model: { provider: "codex-foundry", id: input.modelId },
          tools: nativeReadTools,
          openRuntimeSession: open,
          nativeWorker: true,
          nativeControl: {
            mode: "plan",
            prepare: async () => ({
              mode: "plan",
              action: "none",
              sessionKey: key,
              persistent: false,
              previous: null,
            }),
            observe: async () => {},
            finish: async () => {},
            receipt: async () => {
              throw new Error("Worker cannot certify completion");
            },
            tool: async (name, args) => {
              if (++calls > 8) throw new Error("Worker read allowance exhausted");
              return control.tool(runId, name, args);
            },
          },
        },
        { ...context, signal },
      )) {
        if (event.type === "text") text += event.text;
        if (event.type === "usage") usage = event;
        if (event.type === "ask" || event.type === "takeover")
          throw new Error("Worker cannot acquire extra authority");
        if (text.length > 8000) throw new Error("Worker output cap");
      }
      return {
        text,
        needsApproval: true,
        usage: usage
          ? {
              input_tokens:
                usage.inputTokens !== null && usage.cacheReadTokens !== null
                  ? usage.inputTokens + usage.cacheReadTokens
                  : undefined,
              input_tokens_details: { cached_tokens: usage.cacheReadTokens },
              output_tokens: usage.outputTokens,
              total_tokens: usage.totalTokens,
            }
          : undefined,
      };
    },
  });
  return helper.helper(runId, executionId, {...args,instructions:args.instructions??'Use only the offered scoped read-only tools. Report exactly which files were inspected and the remaining uncertainty. No writes, policy approval or solver work.'});
}
