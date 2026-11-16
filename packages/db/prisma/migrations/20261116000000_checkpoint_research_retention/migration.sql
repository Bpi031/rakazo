-- Research snapshots keep their original conversation identity after live data is deleted.
-- Drop only the live-thread dependencies; existing archive rows and IDs stay unchanged.
ALTER TABLE "conversation_branches" DROP CONSTRAINT "conversation_branches_threadId_fkey";
ALTER TABLE "checkpoints" DROP CONSTRAINT "checkpoints_threadId_fkey";
ALTER TABLE "rollback_audit_logs" DROP CONSTRAINT "rollback_audit_logs_threadId_fkey";
