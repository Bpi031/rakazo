ALTER TABLE "threads" ADD COLUMN "checkpointLabelRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "checkpoints" ADD COLUMN "customLabel" TEXT;
