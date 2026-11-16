-- P3-04: loan workflow (approval, re-consent offers, disbursement link)
-- AlterEnum


ALTER TYPE "LoanStatus" ADD VALUE 'AWAITING_RECONSENT';
ALTER TYPE "LoanStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "LoanStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "loans" ADD COLUMN     "approvalNote" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "disbursementId" TEXT,
ADD COLUMN     "disbursementValueDate" DATE,
ADD COLUMN     "offerExpiresAt" TIMESTAMP(3),
ADD COLUMN     "requestedDurationMonths" INTEGER,
ADD COLUMN     "termsVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "loans_disbursementId_key" ON "loans"("disbursementId");

-- CreateIndex
CREATE INDEX "loans_status_offerExpiresAt_idx" ON "loans"("status", "offerExpiresAt");

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_disbursementId_fkey" FOREIGN KEY ("disbursementId") REFERENCES "disbursements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Database-enforced loan invariants (guide §0: the database enforces what it can).
-- NOT VALID keeps any legacy development rows untouched; new and updated rows are checked.
ALTER TABLE "loans" ADD CONSTRAINT "loans_requested_amount_positive" CHECK ("requestedAmount" > 0) NOT VALID;
ALTER TABLE "loans" ADD CONSTRAINT "loans_approved_amount_valid" CHECK ("approvedAmount" IS NULL OR ("approvedAmount" > 0 AND "approvedAmount" <= "requestedAmount")) NOT VALID;
ALTER TABLE "loans" ADD CONSTRAINT "loans_duration_range" CHECK ("duration" BETWEEN 1 AND 12) NOT VALID;
ALTER TABLE "loan_instalments" ADD CONSTRAINT "loan_instalments_amounts_non_negative" CHECK ("principalDue" >= 0 AND "interestDue" >= 0 AND "principalPaid" >= 0 AND "interestPaid" >= 0 AND "penaltyAssessed" >= 0 AND "penaltyPaid" >= 0 AND "penaltyWaived" >= 0) NOT VALID;
ALTER TABLE "loan_instalments" ADD CONSTRAINT "loan_instalments_not_overpaid" CHECK ("principalPaid" <= "principalDue" AND "interestPaid" <= "interestDue") NOT VALID;
