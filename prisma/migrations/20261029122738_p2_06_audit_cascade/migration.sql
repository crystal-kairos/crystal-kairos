-- DropForeignKey
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actorId_fkey";

-- DropForeignKey
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_affectedUserId_fkey";

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_affectedUserId_fkey" FOREIGN KEY ("affectedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
