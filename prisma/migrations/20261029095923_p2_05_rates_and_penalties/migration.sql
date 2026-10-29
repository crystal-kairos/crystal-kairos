-- CreateEnum
CREATE TYPE "PenaltyCapType" AS ENUM ('PERCENT_OF_PRINCIPAL', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "PolicyUpdateStatus" AS ENUM ('DRAFT', 'SENT', 'DISCARDED');

-- CreateEnum
CREATE TYPE "EAjoPayoutStatus" AS ENUM ('NOT_ELIGIBLE', 'ELIGIBLE', 'APPROVED', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "e_ajo_groups" ADD COLUMN     "contributionFrequency" TEXT NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "durationMonths" INTEGER,
ADD COLUMN     "latePenaltyDailyPercent" DECIMAL(7,4),
ADD COLUMN     "maxMembersPerSlot" INTEGER,
ADD COLUMN     "penaltyCapType" "PenaltyCapType",
ADD COLUMN     "penaltyCapValue" DECIMAL(15,4);

-- AlterTable
ALTER TABLE "e_ajo_members" ADD COLUMN     "earlySlotPenaltyPercent" DECIMAL(7,4),
ADD COLUMN     "latePenaltyDailyPercent" DECIMAL(7,4),
ADD COLUMN     "penaltyCapType" "PenaltyCapType",
ADD COLUMN     "penaltyCapValue" DECIMAL(15,4);

-- AlterTable
ALTER TABLE "loans" ADD COLUMN     "interestCalculationMethod" TEXT NOT NULL DEFAULT 'FLAT_MONTHLY_ON_ORIGINAL_PRINCIPAL',
ADD COLUMN     "latePenaltyDailyPercent" DECIMAL(7,4),
ADD COLUMN     "loanTermRateVersion" INTEGER,
ADD COLUMN     "monthlyInterestRatePercent" DECIMAL(7,4),
ADD COLUMN     "penaltyCapType" "PenaltyCapType",
ADD COLUMN     "penaltyCapValue" DECIMAL(15,4);

-- AlterTable
ALTER TABLE "savings" ADD COLUMN     "durationMonths" INTEGER,
ADD COLUMN     "interestCalculationMethod" TEXT NOT NULL DEFAULT 'SIMPLE_INTEREST_HELD_FRACTION',
ADD COLUMN     "ratePercent" DECIMAL(7,4),
ADD COLUMN     "savingsProductTermRateVersion" INTEGER;

-- AlterTable
ALTER TABLE "savings_products" ALTER COLUMN "rates" DROP NOT NULL;

-- CreateTable
CREATE TABLE "e_ajo_slot_policies" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "slotNumber" INTEGER NOT NULL,
    "earlySlotPenaltyPercent" DECIMAL(7,4) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e_ajo_slot_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "e_ajo_payouts" (
    "id" TEXT NOT NULL,
    "eajoMemberId" TEXT NOT NULL,
    "expectedPayout" DECIMAL(15,2) NOT NULL,
    "advanceAmount" DECIMAL(15,2) NOT NULL,
    "earlySlotPenaltyPercent" DECIMAL(7,4) NOT NULL,
    "earlySlotPenalty" DECIMAL(15,2) NOT NULL,
    "netPayout" DECIMAL(15,2) NOT NULL,
    "status" "EAjoPayoutStatus" NOT NULL DEFAULT 'NOT_ELIGIBLE',
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "disbursedAt" DATE,
    "disbursementReference" TEXT,
    "disbursementEvidenceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "e_ajo_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "savings_product_term_rates" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "durationMonths" INTEGER NOT NULL,
    "ratePercent" DECIMAL(7,4) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" DATE,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "savings_product_term_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_term_rates" (
    "id" TEXT NOT NULL,
    "durationMonths" INTEGER NOT NULL,
    "monthlyInterestPercent" DECIMAL(7,4) NOT NULL,
    "latePenaltyDailyPercent" DECIMAL(7,4) NOT NULL,
    "penaltyCapType" "PenaltyCapType" NOT NULL,
    "penaltyCapValue" DECIMAL(15,4) NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_term_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_update_drafts" (
    "id" TEXT NOT NULL,
    "status" "PolicyUpdateStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "recipientCount" INTEGER,

    CONSTRAINT "policy_update_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "e_ajo_slot_policies_groupId_slotNumber_key" ON "e_ajo_slot_policies"("groupId", "slotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "e_ajo_payouts_eajoMemberId_key" ON "e_ajo_payouts"("eajoMemberId");

-- CreateIndex
CREATE INDEX "savings_product_term_rates_productId_isActive_idx" ON "savings_product_term_rates"("productId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "savings_product_term_rates_productId_durationMonths_version_key" ON "savings_product_term_rates"("productId", "durationMonths", "version");

-- CreateIndex
CREATE INDEX "loan_term_rates_durationMonths_effectiveFrom_idx" ON "loan_term_rates"("durationMonths", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "loan_term_rates_durationMonths_version_key" ON "loan_term_rates"("durationMonths", "version");

-- AddForeignKey
ALTER TABLE "e_ajo_slot_policies" ADD CONSTRAINT "e_ajo_slot_policies_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "e_ajo_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_ajo_slot_policies" ADD CONSTRAINT "e_ajo_slot_policies_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_ajo_payouts" ADD CONSTRAINT "e_ajo_payouts_eajoMemberId_fkey" FOREIGN KEY ("eajoMemberId") REFERENCES "e_ajo_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings_product_term_rates" ADD CONSTRAINT "savings_product_term_rates_productId_fkey" FOREIGN KEY ("productId") REFERENCES "savings_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_term_rates" ADD CONSTRAINT "loan_term_rates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
