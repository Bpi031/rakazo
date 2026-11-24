-- Legacy snapshots retain their original pools and restoration semantics.
-- A missing identity must never be inferred from a bot's current assignment.
ALTER TABLE "checkpoints" ADD COLUMN "workspaceKey" TEXT;
