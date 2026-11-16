-- P3-03: savings workflows (durationMonths 1..12, rate snapshots, first-deposit start,
-- principal lots and monthly interest accruals). See docs/decisions/schema-design.md §3.6.

-- CreateEnum
CREATE TYPE "SavingsWithdrawalKind" AS ENUM ('MATURITY', 'EARLY', 'RECOVERY', 'SETTLEMENT');

-- 1. New columns (added nullable first so existing rows can be back-filled).
ALTER TABLE "savings"
ADD COLUMN "cancellationReason" TEXT,
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "interestMethod" TEXT NOT NULL DEFAULT 'SIMPLE_HELD_TERM_FRACTION',
ADD COLUMN "maturedAt" TIMESTAMP(3),
ADD COLUMN "ratePercentSnapshot" DECIMAL(7,4),
ADD COLUMN "rateVersionSnapshot" INTEGER,
ADD COLUMN "withdrawalDisbursementId" TEXT,
ADD COLUMN "withdrawalInterest" DECIMAL(15,2),
ADD COLUMN "withdrawalKind" "SavingsWithdrawalKind",
ADD COLUMN "withdrawalPrincipal" DECIMAL(15,2),
ADD COLUMN "withdrawalRequestedAt" TIMESTAMP(3),
ADD COLUMN "withdrawnAt" TIMESTAMP(3);

-- 2. Back-fill from the legacy columns (no production data exists, A-24; this keeps dev data usable).
UPDATE "savings" SET "durationMonths" = CASE "maturity"
    WHEN 'ONE_MONTH' THEN 1
    WHEN 'THREE_MONTHS' THEN 3
    WHEN 'SIX_MONTHS' THEN 6
    ELSE 12 END
  WHERE "durationMonths" IS NULL;
UPDATE "savings" SET
  "ratePercentSnapshot" = COALESCE("ratePercent", "interestRate", 0),
  "rateVersionSnapshot" = COALESCE("savingsProductTermRateVersion", 1);

-- 3. Status mapping: admin approval no longer exists; early withdrawal is WITHDRAWN + kind EARLY.
ALTER TABLE "savings" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "savings" ALTER COLUMN "status" TYPE TEXT USING ("status"::text);
UPDATE "savings" SET "withdrawalKind" = 'EARLY', "status" = 'WITHDRAWN' WHERE "status" = 'EARLY_WITHDRAWAL';
UPDATE "savings" SET "withdrawalKind" = 'MATURITY' WHERE "status" = 'WITHDRAWN' AND "withdrawalKind" IS NULL;
UPDATE "savings" SET "status" = 'PENDING' WHERE "status" = 'APPROVED';
UPDATE "savings" SET "status" = 'CANCELLED', "cancellationReason" = COALESCE("rejectionReason", 'Rejected under the legacy approval flow')
  WHERE "status" = 'REJECTED';
DROP TYPE "SavingsStatus";
CREATE TYPE "SavingsStatus" AS ENUM ('PENDING', 'ACTIVE', 'MATURED', 'WITHDRAWAL_PENDING', 'WITHDRAWN', 'CANCELLED');
ALTER TABLE "savings" ALTER COLUMN "status" TYPE "SavingsStatus" USING ("status"::"SavingsStatus");
ALTER TABLE "savings" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- 4. Tighten and drop legacy columns.
ALTER TABLE "savings"
ALTER COLUMN "durationMonths" SET NOT NULL,
ALTER COLUMN "ratePercentSnapshot" SET NOT NULL,
ALTER COLUMN "rateVersionSnapshot" SET NOT NULL,
DROP COLUMN "accountName",
DROP COLUMN "accountNumber",
DROP COLUMN "accruedInterest",
DROP COLUMN "approvedAt",
DROP COLUMN "approvedBy",
DROP COLUMN "bankName",
DROP COLUMN "earlyWithdrawal",
DROP COLUMN "expectedMaturityAmount",
DROP COLUMN "interestCalculationMethod",
DROP COLUMN "interestRate",
DROP COLUMN "isAnonymousRequest",
DROP COLUMN "maturity",
DROP COLUMN "ratePercent",
DROP COLUMN "rejectionReason",
DROP COLUMN "savingsProductTermRateVersion";

-- DropEnum
DROP TYPE "SavingsMaturity";

-- CreateTable
CREATE TABLE "savings_lots" (
    "id" TEXT NOT NULL,
    "savingsId" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "principal" DECIMAL(15,2) NOT NULL,
    "valueDate" DATE NOT NULL,
    "savingsPeriodId" TEXT,
    "interestBearing" BOOLEAN NOT NULL DEFAULT true,
    "forfeitedAt" TIMESTAMP(3),
    "forfeitReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "savings_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "savings_interest_accruals" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "accrualDate" DATE NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "journalEntryId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "savings_interest_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "savings_lots_allocationId_key" ON "savings_lots"("allocationId");
CREATE INDEX "savings_lots_savingsId_idx" ON "savings_lots"("savingsId");
CREATE INDEX "savings_lots_savingsPeriodId_idx" ON "savings_lots"("savingsPeriodId");
CREATE UNIQUE INDEX "savings_interest_accruals_lotId_accrualDate_key" ON "savings_interest_accruals"("lotId", "accrualDate");
CREATE UNIQUE INDEX "savings_withdrawalDisbursementId_key" ON "savings"("withdrawalDisbursementId");
CREATE INDEX "savings_status_maturityDate_idx" ON "savings"("status", "maturityDate");

-- AddForeignKey
ALTER TABLE "savings" ADD CONSTRAINT "savings_withdrawalDisbursementId_fkey" FOREIGN KEY ("withdrawalDisbursementId") REFERENCES "disbursements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "savings_lots" ADD CONSTRAINT "savings_lots_savingsId_fkey" FOREIGN KEY ("savingsId") REFERENCES "savings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "savings_lots" ADD CONSTRAINT "savings_lots_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "payment_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "savings_lots" ADD CONSTRAINT "savings_lots_savingsPeriodId_fkey" FOREIGN KEY ("savingsPeriodId") REFERENCES "savings_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "savings_interest_accruals" ADD CONSTRAINT "savings_interest_accruals_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "savings_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "savings_interest_accruals" ADD CONSTRAINT "savings_interest_accruals_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints (guide §0: the database enforces what it can).
ALTER TABLE "savings" ADD CONSTRAINT "savings_duration_months_check" CHECK ("durationMonths" >= 1 AND "durationMonths" <= 12);
ALTER TABLE "savings" ADD CONSTRAINT "savings_rate_snapshot_check" CHECK ("ratePercentSnapshot" >= 0 AND "ratePercentSnapshot" <= 100);
ALTER TABLE "savings" ADD CONSTRAINT "savings_balances_nonneg_check" CHECK ("currentBalance" >= 0 AND "totalDeposited" >= 0);
ALTER TABLE "savings" ADD CONSTRAINT "savings_target_amount_check" CHECK ("targetAmount" IS NULL OR "targetAmount" > 0);
ALTER TABLE "savings" ADD CONSTRAINT "savings_withdrawal_amounts_check" CHECK (
  ("withdrawalPrincipal" IS NULL OR "withdrawalPrincipal" >= 0) AND ("withdrawalInterest" IS NULL OR "withdrawalInterest" >= 0));
ALTER TABLE "savings_lots" ADD CONSTRAINT "savings_lots_principal_check" CHECK ("principal" > 0);
ALTER TABLE "savings_interest_accruals" ADD CONSTRAINT "savings_interest_accruals_amount_check" CHECK ("amount" > 0);

-- Savings products: per-term rates live only in savings_product_term_rates (P2-05, D-09).
-- Back-fill version-1 term rates from the legacy columns for products that have none yet.
INSERT INTO "savings_product_term_rates" ("id", "productId", "durationMonths", "ratePercent", "version", "isActive", "createdById", "updatedAt")
SELECT gen_random_uuid()::text, p."id", t."months", t."rate", 1, true, p."createdBy", now()
FROM "savings_products" p
CROSS JOIN LATERAL (VALUES
  (1, p."interestRate1Month"), (3, p."interestRate3Months"), (6, p."interestRate6Months"), (12, p."interestRate12Months")
) AS t("months", "rate")
WHERE t."rate" IS NOT NULL AND t."rate" > 0
  AND NOT EXISTS (SELECT 1 FROM "savings_product_term_rates" r WHERE r."productId" = p."id");

ALTER TABLE "savings_products" DROP COLUMN "interestRate12Months",
DROP COLUMN "interestRate1Month",
DROP COLUMN "interestRate3Months",
DROP COLUMN "interestRate6Months",
ALTER COLUMN "badge" DROP NOT NULL;
