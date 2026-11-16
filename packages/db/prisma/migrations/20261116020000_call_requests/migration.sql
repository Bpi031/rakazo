CREATE TABLE "call_doctors" (
  "id" TEXT NOT NULL, "spaceId" TEXT NOT NULL, "code" TEXT NOT NULL,
  "name" TEXT NOT NULL, "email" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "call_doctors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "call_doctors_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "call_doctors_spaceId_code_key" ON "call_doctors"("spaceId", "code");
CREATE UNIQUE INDEX "call_doctors_spaceId_email_key" ON "call_doctors"("spaceId", "email");
CREATE UNIQUE INDEX "call_doctors_id_spaceId_key" ON "call_doctors"("id", "spaceId");
CREATE TABLE "call_requests" (
  "id" TEXT NOT NULL, "doctorId" TEXT NOT NULL, "spaceId" TEXT NOT NULL, "date" TEXT NOT NULL,
  "type" TEXT NOT NULL, "shift" TEXT NOT NULL DEFAULT '', "text" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3), "deletedByUserId" TEXT,
  CONSTRAINT "call_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "call_requests_doctorId_spaceId_fkey" FOREIGN KEY ("doctorId", "spaceId") REFERENCES "call_doctors"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "call_requests_type_check" CHECK ("type" IN ('no_call', 'prefer_call', 'others')),
  CONSTRAINT "call_requests_text_check" CHECK (("type" = 'others' AND length("text") > 0) OR ("type" <> 'others' AND "text" = ''))
);
CREATE INDEX "call_requests_spaceId_date_deletedAt_idx" ON "call_requests"("spaceId", "date", "deletedAt");
CREATE INDEX "call_requests_doctorId_date_deletedAt_idx" ON "call_requests"("doctorId", "date", "deletedAt");
CREATE TABLE "call_request_logins" (
  "spaceId" TEXT NOT NULL, "emailKey" TEXT NOT NULL, "codeHash" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
  "sentAt" TIMESTAMP(3) NOT NULL, "windowStart" TIMESTAMP(3) NOT NULL, "sends" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "call_request_logins_pkey" PRIMARY KEY ("spaceId", "emailKey"),
  CONSTRAINT "call_request_logins_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "call_request_logins_expiresAt_idx" ON "call_request_logins"("expiresAt");
CREATE TABLE "call_doctor_sessions" (
  "tokenHash" TEXT NOT NULL, "doctorId" TEXT NOT NULL, "spaceId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "call_doctor_sessions_pkey" PRIMARY KEY ("tokenHash"),
  CONSTRAINT "call_doctor_sessions_doctorId_spaceId_fkey" FOREIGN KEY ("doctorId", "spaceId") REFERENCES "call_doctors"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "call_doctor_sessions_doctorId_idx" ON "call_doctor_sessions"("doctorId");
CREATE INDEX "call_doctor_sessions_expiresAt_idx" ON "call_doctor_sessions"("expiresAt");
