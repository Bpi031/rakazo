import type { AgentRuntime } from "@rakazo/adapter-kit";
import { CodexProtocolRuntime, runtimeConfig } from "./codex-protocol.mjs";
import { validateCodexQuestion } from "./codex-question-validation.js";

export class CodexAgentRuntime extends CodexProtocolRuntime implements AgentRuntime {
  constructor() { super({ ...runtimeConfig(), validateQuestion: validateCodexQuestion }); }
}
