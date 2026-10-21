import { describe, expect, it } from "vitest";
import { redactAgentCommandResult, redactShellStreams } from "./agent-environment.js";
import { observeShellCommand } from "./shell-command-stream.js";

describe("binary-safe shell result persistence", () => {
  it("redacts secrets before escaping binary output, without changing exit status", () => {
    const result = redactAgentCommandResult({ stdout: "ELF\0my-secret\uD800", stderr: "\0error", code: 7 }, ["my-secret"]);
    expect(result.code).toBe(7);
    expect(JSON.stringify(result)).not.toContain("my-secret");
    expect(result.stdout).toContain("[redacted]");
    expect(result.stdout).not.toMatch(/[\u0000\uD800-\uDFFF]/u);
    expect(result.stderr).not.toMatch(/[\u0000\uD800-\uDFFF]/u);
  });

  it("continues to withhold split secrets with binary stdout and stderr", () => {
    const live = redactShellStreams({ stdout: "ELF\0SECR", stderr: "ET" }, ["SECRET123"], { withholdPartial: true });
    expect(live.stdout + live.stderr).not.toContain("SECR");
    expect(live.stdout + live.stderr).not.toContain("ET");
    const final = redactShellStreams({ stdout: "ELF\0SECR", stderr: "ET123" }, ["SECRET123"]);
    expect(final.stdout).toContain("[redacted]");
    expect(final.stderr).toBe("");
  });

  it("escapes live and final command output before events or effects receive it", async () => {
    const live: unknown[] = [];
    async function* events() {
      yield { type: "stdout" as const, data: "ELF\0bytes" };
      yield { type: "stderr" as const, data: "\uD800warning" };
      yield { type: "exit" as const, code: 3 };
    }
    const observed = await observeShellCommand(events(), { secrets: [], onOutput: (snapshot) => live.push(snapshot) });
    expect(observed.result.code).toBe(3);
    expect(live.length).toBeGreaterThan(0);
    for (const result of [...live, observed.result]) {
      const value = result as { stdout: string; stderr: string };
      expect(value.stdout + value.stderr).not.toMatch(/[\u0000\uD800-\uDFFF]/u);
    }
  });

  it("redacts and escapes provider error text without replaying the command", async () => {
    let starts = 0;
    async function* events() {
      starts++;
      yield { type: "stdout" as const, data: "starting" };
      throw new Error("binary\0my-secret\uD800");
    }
    let failure: unknown;
    try { await observeShellCommand(events(), { secrets: ["my-secret"] }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("[redacted]");
    expect((failure as Error).message).not.toMatch(/[\u0000\uD800-\uDFFF]/u);
    expect(starts).toBe(1);
  });
});
