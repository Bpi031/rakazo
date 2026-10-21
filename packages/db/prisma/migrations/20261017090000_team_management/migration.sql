CREATE TABLE team_member_controls (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','archived','removed')),
  "quotaBytes" BIGINT NOT NULL DEFAULT 50000000000 CHECK ("quotaBytes" BETWEEN 1048576 AND 1000000000000),
  version INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId", "userId")
);
CREATE TABLE team_actions (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  "actorUserId" TEXT NOT NULL REFERENCES "user"(id), source TEXT NOT NULL,
  action JSONB NOT NULL, digest TEXT NOT NULL, revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', result JSONB, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX team_actions_pending ON team_actions ("organizationId", "actorUserId", status, "createdAt");
CREATE UNIQUE INDEX team_actions_one_executing ON team_actions ("organizationId") WHERE status = 'executing';
CREATE TABLE team_audit (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  "actorUserId" TEXT NOT NULL, "actionId" TEXT, operation TEXT NOT NULL, "targetId" TEXT NOT NULL,
  outcome TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX team_audit_created ON team_audit ("organizationId", "createdAt");
CREATE TABLE team_requests (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  "senderUserId" TEXT NOT NULL REFERENCES "user"(id), "senderBotId" TEXT NOT NULL,
  "recipientUserId" TEXT NOT NULL REFERENCES "user"(id), "recipientBotId" TEXT,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 8000), "idempotencyKey" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1, "runId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId", "senderBotId", "idempotencyKey")
);
CREATE INDEX team_requests_inbox ON team_requests ("organizationId", "recipientUserId", status, "createdAt");
CREATE TABLE team_invites (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  "tokenHash" TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX team_invites_email ON team_invites ("organizationId", email, status);
