-- P3-02B hardening: profile change history must survive (no cascade/set-null on user FKs),
-- and pending-request lookups by (userId, changeType, status) need an index.

-- DropForeignKey
ALTER TABLE "profile_change_requests" DROP CONSTRAINT "profile_change_requests_reviewedById_fkey";

-- DropForeignKey
ALTER TABLE "profile_change_requests" DROP CONSTRAINT "profile_change_requests_userId_fkey";

-- CreateIndex
CREATE INDEX "profile_change_requests_userId_changeType_status_idx" ON "profile_change_requests"("userId", "changeType", "status");

-- AddForeignKey
ALTER TABLE "profile_change_requests" ADD CONSTRAINT "profile_change_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_change_requests" ADD CONSTRAINT "profile_change_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

