-- AlterTable users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfaBackupCodes" JSONB;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfaEnrolledAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfaResetAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lockoutCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deactivationReason" TEXT;

-- CreateTable user_sessions
CREATE TABLE IF NOT EXISTS "user_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "userAgentLabel" TEXT,
    "ipHash" TEXT,
    "mfaVerifiedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "user_sessions_userId_revokedAt_expiresAt_idx" ON "user_sessions"("userId", "revokedAt", "expiresAt");

-- CreateTable login_attempts
CREATE TABLE IF NOT EXISTS "login_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "emailHash" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "login_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "login_attempts_emailHash_createdAt_idx" ON "login_attempts"("emailHash", "createdAt");
CREATE INDEX IF NOT EXISTS "login_attempts_ipHash_createdAt_idx" ON "login_attempts"("ipHash", "createdAt");

-- CreateTable society_settings
CREATE TABLE IF NOT EXISTS "society_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "society_settings_pkey" PRIMARY KEY ("key")
);
