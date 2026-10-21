import type { AdapterContext, AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { ManagedReasoning } from "./managed-reasoning.mjs";
export function runtimeConfig(env?: NodeJS.ProcessEnv): { baseUrl: string; models: string[]; key: string; reasoning: ManagedReasoning; modalities: Record<string, ("text" | "image")[]>; structuredOutputs: Record<string, boolean>; requestMetrics: boolean };
export function runtimeFailure(error: unknown): Error;
export const TASK_EXECUTION_GUIDANCE: string;
export class CodexProtocolRuntime implements AgentRuntime {
  constructor(options: { baseUrl: string; models: string[]; key: string; reasoning?: ManagedReasoning; modalities?: Record<string, ("text" | "image")[]>; structuredOutputs?: Record<string, boolean>; requestMetrics?: boolean });
  describe(): ReturnType<AgentRuntime["describe"]>;
  abort(runId: string): Promise<void>;
  run(request: AgentRunRequest, context?: Partial<AdapterContext>): AsyncIterable<AgentRuntimeEvent>;
}
