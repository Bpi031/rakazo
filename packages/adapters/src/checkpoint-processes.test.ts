import { execFileSync } from "node:child_process";
import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { CheckpointConflictError } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import {
  assertCheckpointWritersIdle,
  stopCheckpointWriters,
} from "./checkpoints/checkpoint-processes.js";

const computer: ComputerRef = {
  id: "computer",
  kind: "docker",
  botId: "bot-a",
  providerRef: "test",
};
const context = createAdapterContext({ spaceId: "space", userId: "user" }, "bot-a", "test");
const fixture = (code: number, output?: string) =>
  vi.fn<SandboxProvider["execute"]>(async function* () {
    if (output) yield { type: "stdout", data: `${output}\n` };
    yield { type: "exit", code };
  });

it("runs the writer check from the sandbox home", async () => {
  const execute = fixture(0, "checkpoint-writers-stopped");
  await stopCheckpointWriters({ execute }, computer, context);
  expect(execute.mock.calls[0]?.[1]).toMatchObject({ cwd: "/home/rakazo" });
});

it("checks quiescence without signalling workspace processes", async () => {
  const execute = fixture(0, "checkpoint-writers-idle");
  await assertCheckpointWritersIdle({ execute }, computer, context);
  const request = execute.mock.calls[0]![1];
  expect(request.argv.at(-1)).not.toContain("os.kill");
});

it("refuses an unconfirmed idle state instead of capturing a running writer", async () => {
  const execute = fixture(1);
  await expect(assertCheckpointWritersIdle({ execute }, computer, context)).rejects.toThrow(
    "Could not confirm workspace writers are idle",
  );
});

it("reports a confirmed active writer as a conflict, not an inspection error", async () => {
  const execute = fixture(75, "checkpoint-writers-busy");
  await expect(assertCheckpointWritersIdle({ execute }, computer, context)).rejects.toBeInstanceOf(
    CheckpointConflictError,
  );
});

it("restricts Team process inspection to the current Bot root", async () => {
  const execute = fixture(0, "checkpoint-writers-stopped");
  await stopCheckpointWriters({ execute }, computer, context, "team");
  const request = execute.mock.calls[0]![1];
  expect(request.argv[3]).toContain('checkpoint_roots=["/home/rakazo/bots/bot-a"]');
  expect(request.argv[3]).toContain("checkpoint_team=True");
  expect(request.argv[3]).not.toContain("/home/rakazo/workspace");
  expect(request.argv[3]).not.toContain("/home/rakazo/shared");
  expect(request.argv[3]).toContain("if checkpoint_team and native");
  if (process.platform === "linux") {
    const definitions = request.argv[3]!.split("for sig in [signal.SIGTERM")[0];
    const result = execFileSync(
      "python3",
      [
        "-c",
        `${definitions}
rows={
  9000001:(0,'1','S','python rakazo-background-launch','/home/rakazo/shared',False),
  9000002:(0,'2','S','python rakazo-terminal.py','/home/rakazo/bots/bot-b',False),
  9000003:(0,'3','S','python job.py','/home/rakazo/bots/bot-a',False),
  9000004:(9000003,'4','S','python child.py','/tmp',False)
}
assert victims(rows)=={9000003,9000004}, victims(rows)
print('own-only')
`,
      ],
      { encoding: "utf8" },
    );
    expect(result.trim()).toBe("own-only");
  }
});
