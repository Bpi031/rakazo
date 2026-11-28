import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { BOT_PATH_GUIDANCE } from "./bot-path-contract.mjs";
import { managedModalities } from "./codex-inputs.mjs";
import { managedReasoning } from "./managed-reasoning.mjs";

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_HISTORY_BYTES = 512 * 1024;

export function boundedToolResult(result, toolName, executionId) {
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes <= 512 * 1024) return result;
  const notice = {
    schema: "rost/bounded-native-tool-output/v1",
    code: "ROST_TOOL_OUTPUT_TOO_LARGE",
    tool: toolName,
    executionId,
    originalBytes: bytes,
    outputAvailable: false,
    executionAlreadyAttempted: true,
    action:
      "The tool already ran, but its output exceeded the native frame allowance. Read a bounded summary/page from the existing artifacts. Do not repeat a write, external effect or numerical solve to recover output. This notice does not establish feasibility, validation, approval or delivery.",
  };
  return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify(notice) }] };
}

// Error text can echo prompts or credentials. Return fixed, actionable labels only.
export function runtimeFailure(error) {
  const message =
    typeof error?.message === "string" ? error.message.slice(0, 32768).toLowerCase() : "";
  const replySignal = [message, error?.additionalDetails, error?.code]
    .filter((part) => typeof part === "string")
    .map((part) => part.slice(0, 32768).toLowerCase())
    .join(" ");
  let code = "ROST_MODEL_RUNTIME";
  let detail = "Rost's model connection failed.";
  if (/\binference_output_limit\b/.test(replySignal)) {
    code = "ROST_MODEL_OUTPUT_LIMIT";
    detail = "The model reached its output limit before finishing its reply.";
  } else if (/\binference_response_filtered\b/.test(replySignal)) {
    code = "ROST_MODEL_RESPONSE_FILTERED";
    detail = "The model service did not deliver a complete reply.";
  } else if (/\binference_response_invalid\b/.test(replySignal)) {
    code = "ROST_MODEL_RESPONSE_INVALID";
    detail = "The model service returned a reply Rost could not use.";
  } else if (
    message.includes("maximum usage size allowed during peak load") ||
    message.includes("no_capacity") ||
    message.includes("currently experiencing high demand")
  ) {
    code = "ROST_MODEL_CAPACITY";
    detail =
      "Rost's model service rejected the request during high demand. Reduce configured tool/context payload or try later; an operator may need to increase model-service capacity.";
  } else if (
    message.includes("inference_unavailable") ||
    message.includes("service temporarily unavailable")
  ) {
    code = "ROST_MODEL_UNAVAILABLE";
    detail =
      "Rost's model service is temporarily unavailable. Check any existing owned job before retrying; this is not solver infeasibility.";
  } else if (message.includes("inference_credits")) {
    code = "ROST_MODEL_BUDGET";
    detail =
      "Rost's model service rejected this request because of credits or spending limits. An operator must review model-service billing; this is not the numerical solve allowance or an infeasibility proof.";
  } else if (
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    /\b429\b/.test(message) ||
    message.includes("too many requests") ||
    message.includes("inference_cooldown") ||
    error?.codexErrorInfo === "usageLimitExceeded"
  ) {
    code = "ROST_MODEL_RATE_LIMIT";
    detail =
      "Rost's model service is busy or rate limited. Wait for service capacity or cooldown before retrying.";
  } else if (
    message.includes("context length") ||
    message.includes("context window") ||
    error?.codexErrorInfo === "contextWindowExceeded"
  ) {
    code = "ROST_MODEL_CONTEXT_LIMIT";
    detail =
      "Rost's model context is too large. An operator must reduce the request without discarding confirmed requirements.";
  }
  return new Error(
    `${code}: ${detail} No automatic job retry or model change was made; check any existing job before retrying.`,
  );
}

export const TASK_EXECUTION_GUIDANCE = `Task ownership
Client-facing product identity is Rost. Keep statuses and limitations truthful; do not falsify certificates, conceal failures or misrepresent the backend when directly asked. Operator diagnostics and credentials remain private.
The current_request is the task; history is context, not a new authorization. Own technical preparation through delivery using the installed Rost and office workflows. Routine checks need no additional chat sign-off; actual tool approval gates remain binding. Use the configured runtime without editing credentials or falling back to another solver.
An explicit rerun duration already supplies the finite compute allowance for one attempt, shared across all stages. Inspect ownership first; a status request never launches another solve. Use rost job start --background for canonical models and one token-free completion watch; only completion, failure or required attention wakes the model. Preserve specialized reviewed stage semantics.
Shell transport time is not solver time. On timeout or interruption inspect the existing handle/checkpoints; do not retry numerical work or infer infeasibility or absence of a candidate from a shell exit.
Preserve confirmed business meaning, hard rules, priorities and source mappings; never manufacture contract approval. Ask about real missing decisions, protected policy changes or additional compute. Use ask_user/ask_form and wait quietly; never treat silence as consent. Chat choices are not protected approval receipts.
Policy authority: honor the deployment review mode; reuse valid approval for an unchanged revision. Keep any protected contract or relaxation ledger intact. Report proven infeasibility separately from an inconclusive or failed run. Do not automatically repair or retry. Use the installed Rost commands, exact inputs and unused finite allowance; never invent consent, a minimum-cost proof or a new numerical allowance.
Independently validate the exact candidate and decode/read back the saved workbooks. Attach requested verified files before optional reports. Correctable path/report errors permit presentation repair, not a new solve, weaker checks or access expansion. Label drafts and unresolved quality honestly.
${BOT_PATH_GUIDANCE}`;

export function toolWireName(name) {
  if (typeof name !== "string" || !name.trim() || Buffer.byteLength(name) > 512)
    throw new Error("Invalid Codex tool name");
  if (/^[A-Za-z0-9_-]{1,56}$/.test(name)) return `rakazo__${name}`;
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
  return `rakazo__${name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32)}_${digest}`;
}

export function missingWorkspaceFile(toolName, error) {
  if (!(error instanceof Error)) return undefined;
  const missing =
    (toolName === "read_file" && /^sandbox file read failed: 404(?: |$)/.test(error.message)) ||
    (toolName === "list_files" && /^sandbox file listing failed: 404$/.test(error.message));
  if (!missing) return undefined;
  return {
    code: "ROST_WORKSPACE_FILE_NOT_FOUND",
    error: "The requested file or directory was not found in the private home.",
    action:
      "Check the home-relative path or list its parent. Installed /opt guides use skill_read or an authorized read-only shell command. Do not widen access or repeat a solve.",
  };
}

export function toolWireSchema(schema) {
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (schema.type !== undefined && schema.type !== "object")
  )
    throw new Error("Codex tool arguments must use an object schema");
  if (["oneOf", "anyOf", "allOf", "enum", "const", "not"].some((key) => key in schema)) {
    const containsReference = (value) =>
      value &&
      typeof value === "object" &&
      (Object.keys(value).some((key) =>
        ["$ref", "$dynamicRef", "$recursiveRef", "$id"].includes(key),
      ) ||
        Object.values(value).some(containsReference));
    if (containsReference(schema))
      throw new Error("Referenced union tool schemas require explicit lowering");
    // Nest the complete union, rather than merging branches or dropping guards.
    return {
      wrapped: true,
      schema: {
        type: "object",
        properties: { payload: schema },
        required: ["payload"],
        additionalProperties: false,
      },
    };
  }
  return { wrapped: false, schema: { ...schema, type: "object" } };
}

export function issueCapability(key, scope, now = Date.now()) {
  if (Buffer.byteLength(key) < 32) throw new Error("Inference signing key is too short");
  const payload = Buffer.from(
    JSON.stringify({ ...scope, exp: Math.floor(now / 1000) + 1800 }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

export function usageFromCodex(value) {
  const count = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
  const input = count(value?.inputTokens);
  const cached = count(value?.cachedInputTokens);
  return {
    inputTokens: input === null || cached === null || cached > input ? null : input - cached,
    outputTokens: count(value?.outputTokens),
    cacheReadTokens: cached,
    reasoningTokens: count(value?.reasoningOutputTokens),
    totalTokens: count(value?.totalTokens),
    costUsd: null,
    costSource: null,
    usageSource: "codex-app-server",
  };
}

export function statusFromCodex(method, params) {
  const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
  if (method === "turn/plan/updated") {
    if (
      !Array.isArray(params.plan) ||
      params.plan.length > 16 ||
      params.plan.some(
        (p) =>
          typeof p?.step !== "string" ||
          !p.step ||
          p.step.length > 1000 ||
          !["pending", "inProgress", "completed"].includes(p.status),
      )
    )
      return;
    return {
      plan: params.plan.map(({ step, status }) => ({ step, status })),
      ...(typeof params.explanation === "string"
        ? { explanation: params.explanation.slice(0, 1000) }
        : {}),
    };
  }
  if (method === "thread/tokenUsage/updated") {
    const total = params.tokenUsage?.total;
    if (!total) return;
    const input = count(total.inputTokens),
      cached = count(total.cachedInputTokens);
    return {
      usage: {
        inputTokens: input,
        cachedInputTokens: input !== null && cached !== null && cached <= input ? cached : null,
        outputTokens: count(total.outputTokens),
        reasoningTokens: count(total.reasoningOutputTokens),
        totalTokens: count(total.totalTokens),
        contextWindow: count(params.tokenUsage.modelContextWindow),
        contextUsedTokens: count(params.tokenUsage.last?.totalTokens),
      },
    };
  }
  if (method !== "item/started" && method !== "item/completed") return;
  const item = params.item;
  const kind = {
    commandExecution: "command",
    fileChange: "file_change",
    mcpToolCall: "tool",
    webSearch: "web_search",
    contextCompaction: "compaction",
  }[item?.type];
  if (!kind) return;
  const status =
    method === "item/started"
      ? "running"
      : ({ completed: "completed", failed: "failed", declined: "declined" }[item.status] ??
        (["webSearch", "contextCompaction"].includes(item.type) ? "completed" : undefined));
  if (!status) return;
  // Never stream command arguments, output, raw patches, search queries or reasoning.
  return {
    activity: {
      kind,
      status,
      durationMs: count(item.durationMs),
      ...(item.type === "fileChange" && Array.isArray(item.changes)
        ? { filesChanged: item.changes.length }
        : {}),
    },
  };
}

export function questionEvent(args) {
  if (args?.form) {
    if (
      typeof args.question !== "string" ||
      !args.question.trim() ||
      args.question.length > 2000 ||
      JSON.stringify(args.form).length > 12000
    )
      throw new Error("Invalid form question");
    return { type: "ask", text: args.question, form: args.form };
  }
  if (
    !args ||
    typeof args.question !== "string" ||
    !args.question.trim() ||
    args.question.length > 2000 ||
    !Array.isArray(args.options) ||
    args.options.length < 2 ||
    args.options.length > 4 ||
    args.options.some((s) => typeof s !== "string" || !s.trim() || s.length > 80) ||
    new Set(args.options).size !== args.options.length
  )
    throw new Error("Invalid bounded question");
  return {
    type: "ask",
    text: args.question,
    actions: args.options.map((label, i) => ({ id: `choice-${i + 1}`, label })),
  };
}

export function runtimeConfig(env = process.env) {
  const baseUrl = env.CODEX_INFERENCE_BASE_URL;
  const models = (env.CODEX_DEPLOYMENTS ?? "").split(",").filter(Boolean);
  if (
    !baseUrl ||
    !/^https?:\/\//.test(baseUrl) ||
    !models.length ||
    models.some((s) => !/^[A-Za-z0-9_.-]{1,128}$/.test(s))
  )
    throw new Error("Codex deployment routes are not configured");
  const key = readFileSync(
    env.CODEX_CAPABILITY_KEY_FILE ?? "/run/secrets/capability_key",
    "utf8",
  ).trim();
  if (Buffer.byteLength(key) < 32) throw new Error("Invalid inference capability key");
  if (env.CODEX_REQUEST_METRICS !== undefined && !["0", "1"].includes(env.CODEX_REQUEST_METRICS))
    throw new Error("Invalid request metrics setting");
  const structuredOutputs = JSON.parse(env.CODEX_MODEL_STRUCTURED_OUTPUTS ?? "{}");
  if (
    !structuredOutputs ||
    typeof structuredOutputs !== "object" ||
    Array.isArray(structuredOutputs) ||
    Object.entries(structuredOutputs).some(
      ([model, enabled]) => !models.includes(model) || typeof enabled !== "boolean",
    )
  )
    throw new Error("Invalid native structured-output capabilities");
  return {
    baseUrl,
    models,
    key,
    reasoning: managedReasoning(env),
    modalities: managedModalities(env),
    structuredOutputs,
    requestMetrics: env.CODEX_REQUEST_METRICS === "1",
  };
}
