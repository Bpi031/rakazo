import type { AgentRuntime } from "@rakazo/adapter-kit";
import { CodexProtocolRuntime, runtimeConfig } from "./codex-protocol.mjs";

export class CodexAgentRuntime extends CodexProtocolRuntime implements AgentRuntime {
  constructor() { super(runtimeConfig()); }
}
