CREATE TABLE "agent_workbench_records" (
  "id" TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "runId" TEXT,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "agent_workbench_records_spaceId_userId_botId_kind_createdAt_idx"
  ON "agent_workbench_records"("spaceId", "userId", "botId", "kind", "createdAt");
CREATE INDEX "agent_workbench_records_runId_kind_idx" ON "agent_workbench_records"("runId", "kind");
