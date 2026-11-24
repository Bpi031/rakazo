ALTER TABLE "threads" ADD COLUMN "activeBranchId" TEXT,
  ADD COLUMN "checkpointGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "checkpointBlocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "messages" ADD COLUMN "branchId" TEXT;
ALTER TABLE "events" ADD COLUMN "branchId" TEXT;
ALTER TABLE "runs" ADD COLUMN "branchId" TEXT,
  ADD COLUMN "checkpointGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "routines" ADD COLUMN "checkpointGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "artifacts" ADD COLUMN "branchId" TEXT,
  ADD COLUMN "checkpointHidden" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "conversation_branches" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "parentBranchId" TEXT,
  "parentCutoffMessageSeq" INTEGER,
  "parentCutoffEventSeq" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "conversation_branches_threadId_idx" ON "conversation_branches"("threadId");

INSERT INTO "conversation_branches" ("id", "threadId") SELECT 'initial:' || "id", "id" FROM "threads";
UPDATE "threads" SET "activeBranchId" = 'initial:' || "id";
UPDATE "messages" SET "branchId" = 'initial:' || "threadId";
UPDATE "events" SET "branchId" = 'initial:' || "threadId";
UPDATE "runs" SET "branchId" = 'initial:' || "threadId";
UPDATE "artifacts" a SET "branchId" = t."activeBranchId" FROM "threads" t
  WHERE a."botId" = t."botId" AND a."groupId" IS NULL;

CREATE TABLE "checkpoints" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT,
  "cutoffMessageSeq" INTEGER NOT NULL,
  "cutoffEventSeq" INTEGER NOT NULL,
  "generation" INTEGER NOT NULL,
  "fileManifest" JSONB NOT NULL,
  "businessState" JSONB NOT NULL,
  "taskState" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "checkpoints_threadId_createdAt_idx" ON "checkpoints"("threadId", "createdAt");
CREATE INDEX "checkpoints_spaceId_botId_idx" ON "checkpoints"("spaceId", "botId");

CREATE TABLE "rollback_audit_logs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fromCheckpointId" TEXT,
  "toCheckpointId" TEXT NOT NULL,
  "rescueCheckpointId" TEXT,
  "branchId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "details" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "rollback_audit_logs_threadId_createdAt_idx" ON "rollback_audit_logs"("threadId", "createdAt");
