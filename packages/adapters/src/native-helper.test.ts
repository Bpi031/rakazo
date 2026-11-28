import type { AdapterContext, AgentRunRequest, SandboxProvider } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import type { NativeControl } from "./native-control.js";
import type { WorkflowTextResult } from "./teams/workflow-text.js";

const state = vi.hoisted(() => {
  const tool = vi.fn(async (..._args: Parameters<NativeControl["tool"]>) => ({ text: "source" }));
  return {
    request: undefined as AgentRunRequest | undefined,
    tool,
    context: undefined as Partial<AdapterContext> | undefined,
    instructions: "",
  };
});
vi.mock("./native-control.js", () => ({
  NativeControl: class {
    async actor() {
      return { actor: { userId: "u", spaceId: "s" }, run: { botId: "b", threadId: "t" } };
    }
    tool(...args: Parameters<NativeControl["tool"]>) {
      return state.tool(...args);
    }
  },
}));
vi.mock("./agent-workbench.js", () => ({
  AgentWorkbench: class {
    constructor(
      private deps: {
        generate: (input: {
          message: string;
          instruction: string;
          modelId: string;
        }) => Promise<WorkflowTextResult>;
      },
    ) {}
    async helper(_run: string, _execution: string, args: { instructions: string; task: string }) {
      state.instructions = args.instructions;
      return this.deps.generate({
        message: args.task,
        instruction: args.instructions,
        modelId: "approved",
      });
    }
  },
}));
vi.mock("./codex-protocol.mjs", () => ({
  runtimeConfig: () => ({}),
  CodexProtocolRuntime: class {
    async *run(request: AgentRunRequest, context: Partial<AdapterContext>) {
      state.request = request;
      state.context = context;
      if (!request.nativeControl) throw new Error("Expected native worker controls");
      await request.nativeControl.tool("workspace_read", { path: "workspace/a.rost" });
      yield { type: "text", text: "Inspected source; review required" };
      yield {
        type: "usage",
        inputTokens: 10,
        cacheReadTokens: 2,
        outputTokens: 4,
        totalTokens: 16,
      };
    }
  },
}));

import { nativeHelper } from "./native-helper.js";

it("runs a tool-capable native worker with private read-only tools and attributable usage", async () => {
  const result = await nativeHelper(
    { prisma: {} as PrismaClient, sandbox: {} as SandboxProvider },
    "r",
    "e",
    { name: "Review", task: "Inspect the supplied policy" },
    async () => {
      throw new Error("The mocked runtime must not open a session");
    },
    createAdapterContext({ userId: "u", spaceId: "s" }, "b", "r"),
  );
  const request = state.request;
  if (!request?.nativeControl) throw new Error("Expected a native worker request");
  expect(request.nativeWorker).toBe(true);
  expect(request.history).toEqual([]);
  expect(request.tools?.map((t) => t.name)).toEqual(["workspace_read", "workspace_list"]);
  expect(request.executeTool).toBeUndefined();
  expect(request.runHelper).toBeUndefined();
  expect(state.instructions).toContain("scoped read-only");
  expect(state.context?.signal).toBeInstanceOf(AbortSignal);
  expect(result).toMatchObject({
    text: "Inspected source; review required",
    needsApproval: true,
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
  });
  for (let n = 1; n < 8; n++)
    await request.nativeControl.tool("workspace_read", { path: "workspace/a.rost" });
  await expect(
    request.nativeControl.tool("workspace_read", { path: "workspace/a.rost" }),
  ).rejects.toThrow("allowance");
});
