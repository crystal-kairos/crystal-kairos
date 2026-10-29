-- DropIndex
DROP INDEX "audit_events_actorId_timestamp_idx";

-- DropIndex
DROP INDEX "audit_events_entityType_entityId_idx";

-- AlterTable
ALTER TABLE "audit_events" ADD COLUMN     "affectedUserId" TEXT,
ADD COLUMN     "correlationId" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "outcome" TEXT NOT NULL DEFAULT 'SUCCESS',
ALTER COLUMN "entityId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "audit_events_affectedUserId_createdAt_idx" ON "audit_events"("affectedUserId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_actorId_createdAt_idx" ON "audit_events"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_entityType_entityId_createdAt_idx" ON "audit_events"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_action_createdAt_idx" ON "audit_events"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_createdAt_idx" ON "audit_events"("createdAt");

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_affectedUserId_fkey" FOREIGN KEY ("affectedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
