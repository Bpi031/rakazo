import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { assertCheckpointWritersIdle, stopCheckpointWriters } from "./checkpoint-processes.js";

it("runs the writer check from the sandbox home", async () => {
  const execute = vi.fn(async function* (_computer: unknown, _request: unknown, _context: unknown) {
    yield { type: "stdout", data: "checkpoint-writers-stopped\n" };
    yield { type: "exit", code: 0 };
  });
  await stopCheckpointWriters({ execute } as any, { kind: "docker" } as any, {} as any);
  expect(execute.mock.calls[0]?.[1]).toMatchObject({ cwd: "/home/rakazo" });
});

it("checks quiescence without signalling workspace processes", async () => {
  const execute = vi.fn(async function* (_computer: unknown, _request: unknown, _context: unknown) {
    yield { type: "stdout", data: "checkpoint-writers-idle\n" };
    yield { type: "exit", code: 0 };
  });
  await assertCheckpointWritersIdle({ execute } as any, { kind: "docker" } as any, {} as any);
  const request = execute.mock.calls[0]![1] as { argv: string[] };
  expect(request.argv.at(-1)).not.toContain("os.kill");
});

it("refuses an unconfirmed idle state instead of capturing a running writer", async () => {
  const execute = vi.fn(async function* () {
    yield { type: "exit", code: 1 };
  });
  await expect(
    assertCheckpointWritersIdle({ execute } as any, { kind: "docker" } as any, {} as any),
  ).rejects.toThrow("writers to finish");
});

it("restricts Team process inspection to the current Bot root", async () => {
  const execute = vi.fn(async function* (_computer: unknown, _request: unknown, _context: unknown) {
    yield { type: "stdout", data: "checkpoint-writers-stopped\n" };
    yield { type: "exit", code: 0 };
  });
  await stopCheckpointWriters(
    { execute } as any,
    { kind: "docker" } as any,
    { botId: "bot-a" } as any,
    "team",
  );
  const request = execute.mock.calls[0]![1] as { argv: string[] };
  expect(request.argv[3]).toContain(
    'checkpoint_roots=["/home/rakazo/bots/bot-a"]',
  );
  expect(request.argv[3]).toContain("checkpoint_team=True");
  expect(request.argv[3]).not.toContain("/home/rakazo/workspace");
  expect(request.argv[3]).not.toContain("/home/rakazo/shared");
  expect(request.argv[3]).toContain("if checkpoint_team and native");
  if (process.platform === "linux") {
    const definitions = request.argv[3]!.split("for sig in [signal.SIGTERM")[0];
    const result = execFileSync("python3", ["-c", `${definitions}
rows={
  9000001:(0,'1','S','python rakazo-background-launch','/home/rakazo/shared',False),
  9000002:(0,'2','S','python rakazo-terminal.py','/home/rakazo/bots/bot-b',False),
  9000003:(0,'3','S','python job.py','/home/rakazo/bots/bot-a',False),
  9000004:(9000003,'4','S','python child.py','/tmp',False)
}
assert victims(rows)=={9000003,9000004}, victims(rows)
print('own-only')
`], { encoding: "utf8" });
    expect(result.trim()).toBe("own-only");
  }
});
