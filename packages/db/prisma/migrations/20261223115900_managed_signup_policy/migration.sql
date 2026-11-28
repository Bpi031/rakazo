CREATE TABLE "managed_signup_policy" (
  "id" TEXT NOT NULL DEFAULT 'default' PRIMARY KEY,
  "signupsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "signupAllowlist" TEXT NOT NULL DEFAULT '',
  "signupPolicyInitialized" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Copy before upstream's deferred removal. The new table has no dependency on
-- when the deferred migration is applied, including during rolling upgrades.
DO $$
BEGIN
  IF 3 = (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'deployment_settings'
      AND column_name IN ('signupsEnabled', 'signupAllowlist', 'signupPolicyInitialized')
  ) THEN
    INSERT INTO "managed_signup_policy"
      ("id", "signupsEnabled", "signupAllowlist", "signupPolicyInitialized", "updatedAt")
    SELECT "id", "signupsEnabled", "signupAllowlist", "signupPolicyInitialized", "updatedAt"
    FROM "deployment_settings"
    WHERE "id" = 'default';
  END IF;
END $$;
