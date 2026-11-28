import type { AgentRunRequest, AgentRuntimeEvent, RuntimeSession } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { canonicalToolPaths } from "./bot-path-contract.mjs";
import { CodexProtocolRuntime } from "./codex-protocol.mjs";
import { safeNativeDiff } from "./native-protocol.mjs";

const params = (frame?: Record<string, unknown>) =>
  z.record(z.string(), z.unknown()).parse(frame?.params);

function protocolSession() {
  const queue: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const push = (value: Record<string, unknown>) => {
    queue.push(value);
    wake?.();
    wake = undefined;
  };
  const send = vi.fn<RuntimeSession["send"]>(async (frame) => {
    if (!frame.id) return;
    let result: Record<string, unknown> = {};
    if (frame.method === "thread/start") result = { thread: { id: "native-thread" } };
    if (frame.method === "turn/start") result = { turn: { id: "native-turn" } };
    if (frame.method === "model/list" || frame.method === "skills/list") result = { data: [] };
    push({ id: frame.id, result });
    if (frame.method === "fs/watch") {
      const watch = z.object({ watchId: z.string(), path: z.string() }).parse(params(frame));
      push({
        method: "fs/changed",
        params: {
          watchId: watch.watchId,
          changedPaths: [`${watch.path}/valid.py`, "/home/rakazo/bots/other/private.py"],
        },
      });
    }
    if (frame.method === "turn/start") {
      push({
        method: "item/completed",
        params: {
          threadId: "native-thread",
          turnId: "native-turn",
          item: { type: "agentMessage", id: "answer", text: JSON.stringify({ message: "done" }) },
        },
      });
      push({
        method: "turn/completed",
        params: { turn: { id: "native-turn", status: "completed" } },
      });
    }
  });
  const close = vi.fn(async () => {
    closed = true;
    wake?.();
  });
  return {
    send,
    close,
    messages: (async function* () {
      while (!closed) {
        if (!queue.length) {
          const waiting = deferred<void>();
          wake = waiting.resolve;
          await waiting.promise;
        }
        while (queue.length) yield queue.shift()!;
      }
    })(),
  };
}

it.each([false, true])(
  "runs Team Codex with scoped cwd and shared writes (native=%s)",
  async (native) => {
    const session = protocolSession();
    const workspace = {
      cwd: "/home/rakazo/bots/a",
      roots: ["/home/rakazo/bots/a", "/home/rakazo/shared"],
    };
    const control = {
      mode: "execute" as const,
      prepare: vi.fn<NonNullable<AgentRunRequest["nativeControl"]>["prepare"]>(async () => ({
        workspace,
        mode: "execute",
        action: "none",
        persistent: false,
        sessionKey: "a",
        previous: null,
      })),
      observe: vi.fn(async (_kind: string, _value: unknown) => {}),
      finish: vi.fn(async () => {}),
      tool: vi.fn(async () => ({})),
      receipt: vi.fn(async () => ({ message: "done", status: "answer_recorded" })),
    };
    const runtime = new CodexProtocolRuntime({
      models: ["test"],
      key: "k".repeat(32),
      baseUrl: "http://inference.invalid",
    });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(
      {
        runId: "run",
        botId: "a",
        threadId: "chat",
        model: { id: "test", provider: "codex-foundry" },
        workspace,
        prompt: "hello",
        instructions: "test",
        history: [],
        tools: [],
        openRuntimeSession: async () => session,
        ...(native ? { nativeControl: control } : {}),
      },
      { runId: "run", botId: "a", userId: "u", spaceId: "s" },
    ))
      events.push(event);
    const frames = session.send.mock.calls.map(([frame]) => frame);
    expect(params(frames.find((frame) => frame.method === "thread/start")).cwd).toBe(workspace.cwd);
    expect(
      params(frames.find((frame) => frame.method === "thread/start")).developerInstructions,
    ).toContain(`Path contract: shell cwd is ${workspace.cwd}`);
    expect(
      params(frames.find((frame) => frame.method === "turn/start")).sandboxPolicy,
    ).toMatchObject({
      writableRoots: workspace.roots,
    });
    expect(events.at(-1)?.type).toBe("done");
    if (native) {
      expect(
        frames.filter((frame) => frame.method === "fs/watch").map((frame) => params(frame).path),
      ).toEqual(workspace.roots);
      expect(params(frames.find((frame) => frame.method === "skills/list")).cwds).toEqual(
        workspace.roots,
      );
      const changed = control.observe.mock.calls
        .filter(([kind]) => kind === "files")
        .flatMap(
          ([, value]) => z.object({ changedPaths: z.array(z.string()) }).parse(value).changedPaths,
        );
      expect(changed).toEqual(["bots/a/valid.py", "shared/valid.py"]);
    }
    expect(session.close).toHaveBeenCalledOnce();
  },
);

it("normalizes only authorized Team paths while preserving dedicated aliases", () => {
  const workspace = {
    cwd: "/home/rakazo/bots/a",
    roots: ["/home/rakazo/bots/a", "/home/rakazo/shared"],
  };
  expect(
    canonicalToolPaths(
      "rule_priorities",
      {
        policy: "/home/rakazo/bots/a/case/policy.rost",
        workingDirectory: "shared",
      },
      workspace,
    ),
  ).toEqual({ args: { policy: "bots/a/case/policy.rost", workingDirectory: "shared" } });
  expect(canonicalToolPaths("workspace_read", { path: "shared/input.csv" }, workspace)).toEqual({
    args: { path: "shared/input.csv" },
  });
  for (const [raw, canonical] of [
    ["case/job", "case/job"],
    ["/home/rakazo/shared/case/job", "shared/case/job"],
  ]) {
    expect(canonicalToolPaths("schedule_create", { rostJobOut: raw }, workspace)).toEqual({
      args: { rostJobOut: canonical },
    });
  }
  for (const wrong of [
    "bots/other/case/job",
    "/home/rakazo/bots/ab/case/job",
    "shared/../job",
    "shared",
  ]) {
    expect(canonicalToolPaths("schedule_create", { rostJobOut: wrong }, workspace)).toMatchObject({
      error: { code: "ROST_TOOL_PATH", toolExecuted: false },
    });
  }
  expect(
    canonicalToolPaths("schedule_create", { rostJobOut: "/home/rakazo/workspace/case/job" }),
  ).toEqual({ args: { rostJobOut: "case/job" } });
});

it("keeps native diff evidence within the server's allowed Team roots", () => {
  const diff = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
  expect(safeNativeDiff(diff("bots/a/model.py"), ["bots/a", "shared"]).redacted).toBe(false);
  expect(safeNativeDiff(diff("shared/model.py"), ["bots/a", "shared"]).redacted).toBe(false);
  expect(safeNativeDiff(diff("bots/other/model.py"), ["bots/a", "shared"]).redacted).toBe(true);
  expect(safeNativeDiff(diff("workspace/model.py")).redacted).toBe(false);
});
