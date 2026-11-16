import { expect, it, vi } from "vitest";
import { CodexProtocolRuntime } from "./codex-protocol.mjs";
import { safeNativeDiff } from "./native-protocol.mjs";

function protocolSession() {
  const queue: any[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const push = (value: any) => {
    queue.push(value);
    wake?.();
    wake = undefined;
  };
  const send = vi.fn(async (frame: any) => {
    if (!frame.id) return;
    let result: any = {};
    if (frame.method === "thread/start") result = { thread: { id: "native-thread" } };
    if (frame.method === "turn/start") result = { turn: { id: "native-turn" } };
    if (frame.method === "model/list" || frame.method === "skills/list") result = { data: [] };
    push({ id: frame.id, result });
    if (frame.method === "fs/watch")
      push({
        method: "fs/changed",
        params: {
          watchId: frame.params.watchId,
          changedPaths: [frame.params.path + "/valid.py", "/home/rakazo/bots/other/private.py"],
        },
      });
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
        if (!queue.length)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        while (queue.length) yield queue.shift();
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
      prepare: vi.fn(async () => ({
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
    const events: any[] = [];
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
    expect(frames.find((frame) => frame.method === "thread/start").params.cwd).toBe(workspace.cwd);
    expect(
      frames.find((frame) => frame.method === "turn/start").params.sandboxPolicy.writableRoots,
    ).toEqual(workspace.roots);
    expect(events.at(-1).type).toBe("done");
    if (native) {
      expect(
        frames.filter((frame) => frame.method === "fs/watch").map((frame) => frame.params.path),
      ).toEqual(workspace.roots);
      expect(frames.find((frame) => frame.method === "skills/list").params.cwds).toEqual(
        workspace.roots,
      );
      const changed = control.observe.mock.calls
        .filter(([kind]) => kind === "files")
        .flatMap(([, value]: any) => value.changedPaths);
      expect(changed).toEqual(["bots/a/valid.py", "shared/valid.py"]);
    }
    expect(session.close).toHaveBeenCalledOnce();
  },
);

it("keeps native diff evidence within the server's allowed Team roots", () => {
  const diff = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
  expect(safeNativeDiff(diff("bots/a/model.py"), ["bots/a", "shared"]).redacted).toBe(false);
  expect(safeNativeDiff(diff("shared/model.py"), ["bots/a", "shared"]).redacted).toBe(false);
  expect(safeNativeDiff(diff("bots/other/model.py"), ["bots/a", "shared"]).redacted).toBe(true);
  expect(safeNativeDiff(diff("workspace/model.py")).redacted).toBe(false);
});
