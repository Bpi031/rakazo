import { expect, it, vi } from "vitest";
import { stopCheckpointWriters } from "./checkpoint-processes.js";

it("runs the writer check from the sandbox home", async () => {
  const execute = vi.fn(async function* (_computer: unknown, _request: unknown, _context: unknown) {
    yield { type: "stdout", data: "checkpoint-writers-stopped\n" };
    yield { type: "exit", code: 0 };
  });
  await stopCheckpointWriters({ execute } as any, { kind: "docker" } as any, {} as any);
  expect(execute.mock.calls[0]?.[1]).toMatchObject({ cwd: "/home/rakazo" });
});
