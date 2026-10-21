ALTER TABLE "routines" ADD COLUMN "jobWatch" JSONB;
CREATE UNIQUE INDEX "routine_active_rost_job_watch"
ON "routines" ("botId", ("jobWatch"->>'binding'))
WHERE "active" = true AND "jobWatch" IS NOT NULL;
