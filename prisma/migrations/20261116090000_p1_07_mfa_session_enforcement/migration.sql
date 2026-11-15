-- P1-07 follow-up: TOTP replay protection, step-up separated from MFA login verification,
-- and a per-session counter for failed MFA challenge / step-up attempts.

-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "challengeFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stepUpAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfaLastTotpStep" INTEGER;

