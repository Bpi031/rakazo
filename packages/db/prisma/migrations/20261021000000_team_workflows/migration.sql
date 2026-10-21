CREATE TABLE "team_workflows" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "managerUserId" TEXT NOT NULL,
  "leadBotId" TEXT NOT NULL, "definition" JSONB NOT NULL, "bindings" JSONB NOT NULL,
  "digest" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'draft', "consents" JSONB NOT NULL DEFAULT '{}',
  "reviewExpiresAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "team_workflows_organizationId_managerUserId_idx" ON "team_workflows"("organizationId", "managerUserId");
CREATE TABLE "team_workflow_executions" (
  "id" TEXT PRIMARY KEY, "workflowId" TEXT NOT NULL REFERENCES "team_workflows"("id") ON DELETE RESTRICT,
  "organizationId" TEXT NOT NULL, "sourceUserId" TEXT NOT NULL, "sourceKey" TEXT NOT NULL,
  "message" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'running', "tasks" JSONB NOT NULL,
  "runIds" TEXT[] NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("workflowId", "sourceKey")
);
CREATE INDEX "team_workflow_executions_workflowId_createdAt_idx" ON "team_workflow_executions"("workflowId", "createdAt");
CREATE INDEX "team_workflow_execution_run_ids" ON "team_workflow_executions" USING GIN("runIds");
