import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { materializeCurrentTurnFiles } from "./thread-artifacts.js";

function fixture(change: Record<string, unknown> = {}) {
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const row = { id: "upload-1", name: "../client roster.xlsx", size: bytes.byteLength,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", storageKey: "owned-object",
    hash: createHash("sha256").update(bytes).digest("hex"), ...change };
  const findMany = vi.fn(async () => [row]);
  const writeFile = vi.fn(async (..._args: unknown[]) => {});
  const context = { spaceId: "space", userId: "owner", botId: "bot", operationId: "run",
    traceId: "run", signal: new AbortController().signal };
  return { row, bytes, writeFile, findMany, context,
    deps: { prisma: { artifact: { findMany } }, artifacts: { get: vi.fn(async () => bytes) }, sandbox: { writeFile } } };
}

it("stages owned dedicated uploads directly into the report-compatible workspace using artifact IDs", async () => {
  const f = fixture();
  const result = await materializeCurrentTurnFiles(f.deps as any,
    [{ kind: "file", artifactId: f.row.id, name: f.row.name, size: f.row.size, mimeType: f.row.mimeType }],
    { context: f.context, computer: {} as any, computerMode: "dedicated" });
  expect(f.findMany).toHaveBeenCalledWith({ where: { id: { in: ["upload-1"] }, spaceId: "space", userId: "owner" } });
  expect(result[0]!.path).toBe("workspace/inputs/uploads/upload-1.xlsx");
  expect(f.writeFile).toHaveBeenCalledOnce();
  expect(f.writeFile.mock.calls[0]?.[1]).toMatchObject({ path: result[0]!.path, content: f.bytes });
  expect(result[0]!.path).not.toContain("..");
});

it.each([{ hash: "0".repeat(64) }, { size: 99 }])("rejects mismatched upload metadata before any workspace write", async (change) => {
  const f = fixture(change);
  await expect(materializeCurrentTurnFiles(f.deps as any,
    [{ kind: "file", artifactId: f.row.id, name: f.row.name, size: f.row.size, mimeType: f.row.mimeType }],
    { context: f.context, computer: {} as any, computerMode: "dedicated" }))
    .rejects.toThrow("Attached file integrity check failed");
  expect(f.writeFile).not.toHaveBeenCalled();
});

it("keeps the upstream shared-team path convention unchanged", async () => {
  const f = fixture();
  const result = await materializeCurrentTurnFiles(f.deps as any,
    [{ kind: "file", artifactId: f.row.id, name: f.row.name, size: f.row.size, mimeType: f.row.mimeType }],
    { context: f.context, computer: {} as any, computerMode: "team" });
  expect(result[0]!.path).toBe("attachments/upload-1.xlsx");
  expect(f.writeFile.mock.calls[0]?.[1]).toMatchObject({ path: "bots/bot/attachments/upload-1.xlsx" });
});
