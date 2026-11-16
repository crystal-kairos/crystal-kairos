-- P3-05: e-ajo slot-and-payout model (§2.8, §2.3, A-09)

-- AlterEnum

ALTER TYPE "EAjoPayoutStatus" ADD VALUE 'HELD';
ALTER TYPE "EAjoPayoutStatus" ADD VALUE 'FAILED';

-- DropIndex
DROP INDEX "e_ajo_members_groupId_idx";

-- DropIndex
DROP INDEX "e_ajo_members_groupId_payoutPosition_key";

-- AlterTable
ALTER TABLE "e_ajo_groups" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "activatedById" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "minParticipants" INTEGER;

-- AlterTable
ALTER TABLE "e_ajo_members" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ALTER COLUMN "guarantorName" DROP NOT NULL,
ALTER COLUMN "guarantorPhoneNumber" DROP NOT NULL,
ALTER COLUMN "bankName" DROP NOT NULL,
ALTER COLUMN "accountNumber" DROP NOT NULL,
ALTER COLUMN "accountName" DROP NOT NULL;

-- AlterTable
ALTER TABLE "e_ajo_payouts" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "contributionsHeldAtPayout" DECIMAL(15,2),
ADD COLUMN     "disbursedById" TEXT,
ADD COLUMN     "disbursementEvidenceFileId" TEXT,
ADD COLUMN     "disbursementId" TEXT,
ADD COLUMN     "eligibleAt" TIMESTAMP(3),
ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "heldById" TEXT,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "journalEntryId" TEXT,
ADD COLUMN     "payoutDueDate" DATE;

-- CreateIndex
CREATE INDEX "e_ajo_members_groupId_payoutPosition_idx" ON "e_ajo_members"("groupId", "payoutPosition");

-- CreateIndex
CREATE UNIQUE INDEX "e_ajo_payouts_disbursementId_key" ON "e_ajo_payouts"("disbursementId");

-- CreateIndex
CREATE INDEX "e_ajo_payouts_status_payoutDueDate_idx" ON "e_ajo_payouts"("status", "payoutDueDate");

-- AddForeignKey
ALTER TABLE "e_ajo_payouts" ADD CONSTRAINT "e_ajo_payouts_disbursementId_fkey" FOREIGN KEY ("disbursementId") REFERENCES "disbursements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Database-enforced invariants for the e-ajo product (§0: "the database enforces what it can")
ALTER TABLE "e_ajo_groups"
  ADD CONSTRAINT "chk_eajo_groups_contribution_positive" CHECK ("contributionAmount" > 0),
  ADD CONSTRAINT "chk_eajo_groups_total_slots" CHECK ("totalSlots" IN (4, 6, 12)),
  ADD CONSTRAINT "chk_eajo_groups_max_members_per_slot" CHECK ("maxMembersPerSlot" IS NULL OR "maxMembersPerSlot" >= 1),
  ADD CONSTRAINT "chk_eajo_groups_min_participants" CHECK ("minParticipants" IS NULL OR "minParticipants" >= 1),
  ADD CONSTRAINT "chk_eajo_groups_late_penalty_percent" CHECK ("latePenaltyDailyPercent" IS NULL OR ("latePenaltyDailyPercent" >= 0 AND "latePenaltyDailyPercent" <= 100)),
  ADD CONSTRAINT "chk_eajo_groups_penalty_cap_positive" CHECK ("penaltyCapValue" IS NULL OR "penaltyCapValue" > 0);

ALTER TABLE "e_ajo_slot_policies"
  ADD CONSTRAINT "chk_eajo_slot_policies_percent" CHECK ("earlySlotPenaltyPercent" >= 0 AND "earlySlotPenaltyPercent" <= 100),
  ADD CONSTRAINT "chk_eajo_slot_policies_slot_positive" CHECK ("slotNumber" >= 1);

ALTER TABLE "e_ajo_members"
  ADD CONSTRAINT "chk_eajo_members_slot_positive" CHECK ("payoutPosition" >= 1);

ALTER TABLE "e_ajo_contribution_periods"
  ADD CONSTRAINT "chk_eajo_periods_amounts" CHECK (
    "contributionDue" > 0 AND "contributionPaid" >= 0 AND "contributionPaid" <= "contributionDue"
    AND "penaltyAssessed" >= 0 AND "penaltyPaid" >= 0 AND "penaltyWaived" >= 0
  );

ALTER TABLE "e_ajo_penalty_accruals"
  ADD CONSTRAINT "chk_eajo_penalty_accruals_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "e_ajo_payouts"
  ADD CONSTRAINT "chk_eajo_payouts_amounts" CHECK (
    "expectedPayout" > 0 AND "advanceAmount" >= 0 AND "advanceAmount" < "expectedPayout"
    AND "earlySlotPenalty" >= 0 AND "earlySlotPenalty" <= "advanceAmount"
    AND "netPayout" = "expectedPayout" - "earlySlotPenalty"
    AND ("contributionsHeldAtPayout" IS NULL OR "contributionsHeldAtPayout" >= 0)
  ),
  ADD CONSTRAINT "chk_eajo_payouts_penalty_percent" CHECK ("earlySlotPenaltyPercent" >= 0 AND "earlySlotPenaltyPercent" <= 100);
