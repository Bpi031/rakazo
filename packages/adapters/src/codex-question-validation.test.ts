import { describe, expect, it, vi } from "vitest";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { QuestionForm, QuestionFormInput, formTools } from "@rakazo/contracts";
import { CodexProtocolRuntime } from "./codex-protocol.mjs";
import { validateCodexQuestion } from "./codex-question-validation.js";
import { NativeSessionBusyError } from './native-control.js';

const valid = () => ({ question: "Review these decisions", form: { schema: "rakazo/question-form/v1", fields: [
  { id: "first", label: "First decision", type: "choice", options: ["Keep", "Change"] },
  { id: "second", label: "Second decision", type: "text" },
  { id: "third", label: "Third decision", type: "number", min: 0, max: 2 },
] satisfies [unknown, unknown, unknown] } });
const tooLong = () => {
  const args = valid();
  args.form.fields[1].label = "PRIVATE-SOURCE-".repeat(20);
  args.form.fields[2].label = "x".repeat(201);
  return args;
};

function scenario(calls: any[], validator: typeof validateCodexQuestion | null = validateCodexQuestion) {
  const sent: any[] = [], queue: any[] = [], finished: any[] = [], writes: any[] = [];
  let closed = 0;
  const session = {
    close: async () => { closed++; },
    send: async (m: any) => {
      sent.push(m);
      if (!m.method) { expect(closed).toBe(0); return; }
      let result: any = {};
      if (m.method === "model/list") result = { data: [{ id: "fixture", inputModalities: ["text"] }] };
      if (m.method === "skills/list") result = { data: [{ skills: [] }] };
      if (m.method === "configRequirements/read") result = { requirements: null };
      if (m.method === "thread/start") result = { thread: { id: "t" } };
      if (m.method === "turn/start") result = { turn: { id: "v" } };
      queue.push({ id: m.id, result });
      if (m.method === "turn/start") queue.push(
        { method: "thread/tokenUsage/updated", params: { threadId: "t", turnId: "v", tokenUsage: { total: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 30, totalTokens: 230 } } } },
        ...calls.map((call, i) => ({ id: 100 + i, method: call.native ? "item/tool/requestUserInput" : "item/tool/call", params: { threadId: "t", turnId: "v", callId: `q${i}`, tool: "rakazo__ask_form", ...(call.native ? { questions: call.native } : { arguments: call }) } })),
      );
    },
    messages: { async *[Symbol.asyncIterator]() { for (let i = 0; i < 100 && queue.length; i++) yield queue.shift(); } },
  };
  const request = {
    runId: "r", botId: "b", threadId: "host", model: { id: "fixture", provider: "codex-foundry" }, history: [], prompt: "Ask for a decision", instructions: "", tools: formTools,
    openRuntimeSession: async () => session,
    executeTool: async () => { throw new Error("No effects may be executed"); },
    onUsage: async (event: any) => { writes.push(event); },
    nativeControl: {
      mode: "execute",
      prepare: async () => ({ mode: "execute", action: "none", sessionKey: "a".repeat(64), previous: null, persistent: true }),
      observe: async () => {},
      finish: async (v: any) => { finished.push(v); },
      receipt: async () => { throw new Error("No receipts expected"); },
      tool: async () => { throw new Error("No native tools expected"); },
    },
  } satisfies AgentRunRequest;
  const runtime = new CodexProtocolRuntime({ baseUrl: "https://provider.test", models: ["fixture"], key: "x".repeat(64), validateQuestion: validator ?? undefined });
  const events: any[] = [];
  const run = async () => {
    for await (const e of runtime.run(request, { spaceId: "s", userId: "u", botId: "b", runId: "r" })) {
      if (e.type === "ask") { expect(closed).toBe(1); expect(writes).toHaveLength(1); }
      events.push(e);
    }
  };
  return { run, events, sent, writes, finished, request };
}

describe("question preflight", () => {
  it('opens no model session and emits no usage or tool calls when ownership is busy', async () => {
    const f = scenario([]);
    f.request.nativeControl.prepare = async () => { throw new NativeSessionBusyError(); };
    const open = vi.spyOn(f.request, 'openRuntimeSession');
    await expect(f.run()).rejects.toBeInstanceOf(NativeSessionBusyError);
    expect(open).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]); expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
    expect(f.finished).toEqual([]);
  });
  it("uses the same 200-character contract advertised to the model without truncation", () => {
    const args = valid();
    args.form.fields[0].label = "x".repeat(200);
    expect(QuestionFormInput.safeParse(args).success).toBe(true);
    args.form.fields[0].label += "x";
    const result = validateCodexQuestion({ type: "ask", text: args.question, form: args.form });
    expect(result.success).toBe(false);
    expect(args.form.fields[0].label).toHaveLength(201);
    expect(formTools[0]!.description).toContain("1-200");
  });

  it.each([
    (x: any) => { x.form.fields[1].id = "first"; },
    (x: any) => { x.form.fields[0].options = ["Keep", "Keep"]; },
    (x: any) => { x.form.fields[0].options = ["", "Change"]; },
    (x: any) => { x.form.fields[2].min = 3; },
    (x: any) => { x.form.fields[1].type = "password"; },
    (x: any) => { x.form.fields[1].label = "bad\u0000text"; },
  ])("rejects invalid form meaning through the canonical schema", mutate => {
    const args = valid(); mutate(args);
    expect(validateCodexQuestion({ type: "ask", text: args.question, form: args.form }).success).toBe(false);
  });

  it("corrects two oversized labels in the same live turn before pausing and accounting", async () => {
    const f = scenario([tooLong(), valid()]);
    await f.run();
    const reply = f.sent.find(x => x.id === 100 && x.result);
    expect(reply.result.success).toBe(false);
    const notice = JSON.parse(reply.result.contentItems[0].text);
    expect(notice.code).toBe("ROST_QUESTION_INPUT_INVALID");
    expect(notice.issues.map((i: any) => i.path)).toEqual([["form", "fields", 1, "label"], ["form", "fields", 2, "label"]]);
    expect(JSON.stringify(notice)).not.toContain("PRIVATE-SOURCE");
    expect(f.sent.filter(x => x.method === "turn/start")).toHaveLength(1);
    const asks = f.events.filter(x => x.type === "ask");
    expect(asks).toHaveLength(1);
    expect(QuestionForm.safeParse(asks[0].form).success).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ provider: "codex-foundry", model: "fixture", totalTokens: 230 });
    expect(f.finished).toHaveLength(1);
    expect(f.finished[0]).toMatchObject({ paused: true, completed: false });
    expect(f.events.some(x => x.type === "done")).toBe(false);
  });

  it("returns invalid native questions as protocol errors, never fabricated answers", async () => {
    const f = scenario([{ native: [{ question: "x".repeat(201) }] }, valid()]);
    await f.run();
    const reply = f.sent.find(x => x.id === 100 && x.error);
    expect(reply.error.code).toBe(-32602);
    expect(reply.result).toBeUndefined();
    expect(f.events.filter(x => x.type === "ask")).toHaveLength(1);
  });

  it("bounds failed correction attempts, accounts usage and stops without an answer", async () => {
    const f = scenario([tooLong(), tooLong(), tooLong(), tooLong()]);
    await expect(f.run()).rejects.toThrow("ROST_QUESTION_INPUT_INVALID:");
    expect(f.sent.filter(x => x.result?.success === false)).toHaveLength(3);
    expect(f.writes).toHaveLength(1);
    expect(f.events.some(x => x.type === "ask" || x.type === "done")).toBe(false);
    expect(f.finished[0].completed).toBe(false);
    expect(f.finished[0].paused).not.toBe(true);
  });

  it("keeps persistence failures distinct after a valid correction", async () => {
    const f = scenario([tooLong(), valid()]);
    f.request.onUsage = async () => { throw new Error("private ledger error"); };
    await expect(f.run()).rejects.toThrow("ROST_USAGE_RECORD_FAILED:");
    expect(f.events.some(x => x.type === "ask")).toBe(false);
  });

  it("fails closed without a question validator", async () => {
    const f = scenario([valid()], null);
    await expect(f.run()).rejects.toThrow("Question validation is unavailable");
    expect(f.events.some(x => x.type === "ask")).toBe(false);
  });
});
