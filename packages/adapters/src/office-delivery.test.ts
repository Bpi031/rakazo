import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { attachWorkspaceFileToThread } from "./storage/thread-artifacts.js";

describe("office artifact delivery", () => {
  it.each([
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["docm", "application/vnd.ms-word.document.macroEnabled.12"],
    ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["pptm", "application/vnd.ms-powerpoint.presentation.macroEnabled.12"],
    ["pdf", "application/pdf"],
    ["odt", "application/vnd.oasis.opendocument.text"],
    ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
    ["odp", "application/vnd.oasis.opendocument.presentation"],
    ["rtf", "application/rtf"],
  ])("stores exact %s bytes and emits a downloadable file block", async (extension, mimeType) => {
    const bytes = new Uint8Array([80, 75, 3, 4, 0, 255]);
    const put = vi.fn().mockResolvedValue({ id: "stored" });
    const create = vi.fn().mockImplementation(async ({ data }) => ({ id: "artifact", ...data }));
    const artifact = { findFirst: vi.fn().mockResolvedValue(null), create };
    const run = { findUnique: vi.fn().mockResolvedValue({ threadId: "thread", spaceId: "space",
      userId: "owner", botId: "bot", status: "running", checkpointGeneration: 2,
      thread: { checkpointGeneration: 2, checkpointBlocked: false } }) };
    const tx = { artifact, run, $queryRaw: vi.fn().mockResolvedValue([{ lock: "1" }]),
      thread: { update: vi.fn().mockResolvedValue({ activeBranchId: "restored-branch" }) } };
    const result = await attachWorkspaceFileToThread({
      prisma: { artifact, run, $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient,
      artifacts: { put } as unknown as ArtifactStore,
    }, {
      spaceId: "space", userId: "owner", botId: "bot", runId: "run",
      filePath: `output/roster.${extension}`, bytes, operationId: "delivery",
    });
    expect(put).toHaveBeenCalledWith({ name: `roster.${extension}`, mimeType, bytes },
      expect.objectContaining({ spaceId: "space", userId: "owner", botId: "bot" }));
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      spaceId: "space", userId: "owner", botId: "bot", runId: "run", mimeType,
      size: bytes.byteLength, storageKey: "stored", branchId: "restored-branch",
    }) });
    expect(result.block).toEqual({ kind: "file", artifactId: "artifact",
      name: `roster.${extension}`, mimeType, size: bytes.byteLength });
  });
});
