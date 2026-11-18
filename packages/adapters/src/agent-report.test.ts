import { expect, it, vi } from "vitest";
import { readAgentReport, reportInput, reportTools } from "./agent-report.js";
const report = { schema: "rakazo/agent-report/v1", title: "Distribution", sourcePaths: ["workspace/source.json"],
  sections: [{ kind: "text", title: "Measured", text: "Two example calls" }] };
function sandbox(value: unknown, code = 0) { return { execute: vi.fn(async function* () {
  yield { type: "stdout", data: JSON.stringify(value) }; yield { type: "exit", code };
}) } as any; }
const captured = { report, reportSha256: "a".repeat(64), sources: [{ path: "workspace/source.json", sha256: "b".repeat(64), bytes: 5 }] };
it("publishes schema-checked data only and bounds its process without numerical work", async () => {
  const io = sandbox(captured);
  const result = await readAgentReport(io, {} as any, {} as any, { report_path: "workspace/report.json" });
  expect(result).toMatchObject({ block: { kind: "agent_report", evidence: { authority: "agent_analysis" } } });
  expect(io.execute.mock.calls[0][1]).toMatchObject({ cwd: "/home/rakazo", timeoutMs: 15000 });
  expect(io.execute.mock.calls[0][1].argv.slice(0,3)).toEqual(["/opt/office-python/bin/python3", "-I", "-c"]);
  expect(reportTools[0]!.name).toBe("present_report");
});
it("help reads no files and does not give the model an apply or execute callback", async () => {
  const io = sandbox({});
  expect(await readAgentReport(io, {} as any, {} as any, { help: true })).toHaveProperty("guide");
  expect(io.execute).not.toHaveBeenCalled();
  expect(reportInput.safeParse({ report_path: "workspace/report.json", execute: "rm" }).success).toBe(false);
  expect(reportInput.safeParse({ help: true, report_path: "workspace/report.json" }).success).toBe(false);
});
it("refuses unknown process failures but returns correctable renderer rejection without publishing", async () => {
  await expect(readAgentReport(sandbox({}, 1), {} as any, {} as any, { report_path: "workspace/x" })).rejects.toThrow();
  expect(await readAgentReport(sandbox({ ...captured, report: { ...report, approved: true } }), {} as any, {} as any,
    { report_path: "workspace/x" })).toMatchObject({ code: "ROST_REPORT_SCHEMA", reportPublished: false, solveStarted: false });
});
it("returns a bounded failed result for an uploaded source path without widening roots or retrying", async () => {
  const io = sandbox({ code: "ROST_REPORT_SOURCE_PATH", sourceIndex: 7 }, 1);
  const result = await readAgentReport(io, {} as any, {} as any, { report_path: "workspace/report.json" });
  expect(result).toMatchObject({ code: "ROST_REPORT_SOURCE_PATH", sourceIndex: 7,
    reportPublished: false, solveStarted: false });
  expect(result).not.toHaveProperty("block");
  expect(result).toHaveProperty("action", expect.stringContaining("verify matching SHA-256"));
  expect(io.execute).toHaveBeenCalledOnce();
  expect(await readAgentReport(sandbox({ code: "ROST_REPORT_SOURCE_READ", sourceIndex: 0 }, 1),
    {} as any, {} as any, { report_path: "workspace/report.json" })).toHaveProperty("code", "ROST_REPORT_SOURCE_READ");
});
it("rejects bad arguments before file access and does not expose untrusted reader errors", async () => {
  const io = sandbox({});
  expect(await readAgentReport(io, {} as any, {} as any, { report_path: "attachments/upload.json" }))
    .toMatchObject({ code: "ROST_REPORT_ARGUMENTS", reportPublished: false });
  expect(io.execute).not.toHaveBeenCalled();
  for (const value of [{ code: "ROST_REPORT_SOURCE_PATH", sourceIndex: 8 },
    { code: "ROST_REPORT_READ_REJECTED", secret: "PRIVATE_KEY" }]) {
    await expect(readAgentReport(sandbox(value, 1), {} as any, {} as any, { report_path: "workspace/x" }))
      .rejects.toThrow("Report publication failed");
  }
  const broken = { execute: vi.fn(async function* () { throw new Error("sandbox unavailable"); }) } as any;
  await expect(readAgentReport(broken, {} as any, {} as any, { report_path: "workspace/x" }))
    .rejects.toThrow("sandbox unavailable");
});
it("publishes rather than showing help when help is explicitly false", async () => {
  const io = sandbox(captured);
  expect(await readAgentReport(io, {} as any, {} as any, {
    help: false, report_path: "workspace/report.json",
  })).toHaveProperty("block");
  expect(io.execute).toHaveBeenCalledOnce();
});
