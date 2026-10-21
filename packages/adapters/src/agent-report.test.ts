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
it("refuses failed reads and malformed renderer data without publishing", async () => {
  await expect(readAgentReport(sandbox({}, 1), {} as any, {} as any, { report_path: "workspace/x" })).rejects.toThrow();
  await expect(readAgentReport(sandbox({ ...captured, report: { ...report, approved: true } }), {} as any, {} as any, { report_path: "workspace/x" })).rejects.toThrow();
});
it("publishes rather than showing help when help is explicitly false", async () => {
  const io = sandbox(captured);
  expect(await readAgentReport(io, {} as any, {} as any, {
    help: false, report_path: "workspace/report.json",
  })).toHaveProperty("block");
  expect(io.execute).toHaveBeenCalledOnce();
});
