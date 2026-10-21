CREATE TABLE "team_leadership_transfers" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "fromUserId" TEXT NOT NULL,
  "toUserId" TEXT NOT NULL, "fromBotId" TEXT NOT NULL, "toBotId" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL, "digest" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'draft',
  "result" JSONB, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "team_leadership_transfers_organizationId_fromUserId_idx" ON "team_leadership_transfers"("organizationId", "fromUserId");
CREATE INDEX "team_leadership_transfers_organizationId_toUserId_idx" ON "team_leadership_transfers"("organizationId", "toUserId");
