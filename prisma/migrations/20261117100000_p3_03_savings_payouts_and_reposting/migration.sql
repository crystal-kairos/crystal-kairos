-- P3-03 follow-up (owner decisions on OQ-11 and OQ-12):
-- 1. A dedicated permission for savings withdrawal payouts.
ALTER TYPE "AdminPermission" ADD VALUE 'SAVINGS_PAYOUTS_MANAGE';

-- 2. Accruals cleared by a forfeiture that is later lifted are re-posted back-dated to the same
--    accrual date with the next posting sequence (reversed rows stay as history).
DROP INDEX "savings_interest_accruals_lotId_accrualDate_key";
ALTER TABLE "savings_interest_accruals" ADD COLUMN "postingSeq" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "savings_interest_accruals_lotId_accrualDate_postingSeq_key" ON "savings_interest_accruals"("lotId", "accrualDate", "postingSeq");
ALTER TABLE "savings_interest_accruals" ADD CONSTRAINT "savings_interest_accruals_posting_seq_check" CHECK ("postingSeq" >= 0);
