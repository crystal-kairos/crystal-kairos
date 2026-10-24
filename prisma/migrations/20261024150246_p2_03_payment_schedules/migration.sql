-- CreateEnum
CREATE TYPE "PaymentPeriodStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'ONGOING', 'COMPLETED', 'REJECTED', 'OVERDUE', 'WAIVED');

-- CreateTable
CREATE TABLE "e_ajo_contribution_periods" (
    "id" TEXT NOT NULL,
    "eajoMemberId" TEXT NOT NULL,
    "periodNumber" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "contributionDue" DECIMAL(15,2) NOT NULL,
    "contributionPaid" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "penaltyAssessed" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "penaltyPaid" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "penaltyWaived" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "status" "PaymentPeriodStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "e_ajo_contribution_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "e_ajo_penalty_accruals" (
    "id" TEXT NOT NULL,
    "eajoContributionPeriodId" TEXT NOT NULL,
    "penaltyDate" DATE NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "e_ajo_penalty_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "savings_periods" (
    "id" TEXT NOT NULL,
    "savingsId" TEXT NOT NULL,
    "periodNumber" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountDue" DECIMAL(15,2) NOT NULL,
    "amountPaid" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "status" "PaymentPeriodStatus" NOT NULL DEFAULT 'PENDING',
    "interestForfeited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "savings_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_instalments" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "instalmentNumber" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "principalDue" DECIMAL(15,2) NOT NULL,
    "interestDue" DECIMAL(15,2) NOT NULL,
    "principalPaid" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "interestPaid" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "penaltyAssessed" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "penaltyPaid" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "penaltyWaived" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "interestRecognisedAt" TIMESTAMP(3),
    "status" "PaymentPeriodStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loan_instalments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_penalty_accruals" (
    "id" TEXT NOT NULL,
    "loanInstalmentId" TEXT NOT NULL,
    "penaltyDate" DATE NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_penalty_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "e_ajo_contribution_periods_status_dueDate_idx" ON "e_ajo_contribution_periods"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "e_ajo_contribution_periods_eajoMemberId_periodNumber_key" ON "e_ajo_contribution_periods"("eajoMemberId", "periodNumber");

-- CreateIndex
CREATE UNIQUE INDEX "e_ajo_penalty_accruals_eajoContributionPeriodId_penaltyDate_key" ON "e_ajo_penalty_accruals"("eajoContributionPeriodId", "penaltyDate");

-- CreateIndex
CREATE INDEX "savings_periods_status_dueDate_idx" ON "savings_periods"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "savings_periods_savingsId_periodNumber_key" ON "savings_periods"("savingsId", "periodNumber");

-- CreateIndex
CREATE INDEX "loan_instalments_status_dueDate_idx" ON "loan_instalments"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "loan_instalments_loanId_instalmentNumber_key" ON "loan_instalments"("loanId", "instalmentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "loan_penalty_accruals_loanInstalmentId_penaltyDate_key" ON "loan_penalty_accruals"("loanInstalmentId", "penaltyDate");

-- AddForeignKey
ALTER TABLE "e_ajo_contribution_periods" ADD CONSTRAINT "e_ajo_contribution_periods_eajoMemberId_fkey" FOREIGN KEY ("eajoMemberId") REFERENCES "e_ajo_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_ajo_penalty_accruals" ADD CONSTRAINT "e_ajo_penalty_accruals_eajoContributionPeriodId_fkey" FOREIGN KEY ("eajoContributionPeriodId") REFERENCES "e_ajo_contribution_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings_periods" ADD CONSTRAINT "savings_periods_savingsId_fkey" FOREIGN KEY ("savingsId") REFERENCES "savings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_instalments" ADD CONSTRAINT "loan_instalments_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_penalty_accruals" ADD CONSTRAINT "loan_penalty_accruals_loanInstalmentId_fkey" FOREIGN KEY ("loanInstalmentId") REFERENCES "loan_instalments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints for non-negative amounts and positive penalties (PR P2-03)
ALTER TABLE "savings_periods"
  ADD CONSTRAINT "chk_savings_periods_amounts_non_negative"
  CHECK (
    "amountDue" >= 0 AND
    "amountPaid" >= 0
  );

ALTER TABLE "loan_instalments"
  ADD CONSTRAINT "chk_loan_instalments_amounts_non_negative"
  CHECK (
    "principalDue" >= 0 AND
    "interestDue" >= 0 AND
    "principalPaid" >= 0 AND
    "interestPaid" >= 0 AND
    "penaltyAssessed" >= 0 AND
    "penaltyPaid" >= 0 AND
    "penaltyWaived" >= 0
  );

ALTER TABLE "loan_penalty_accruals"
  ADD CONSTRAINT "chk_loan_penalty_accruals_amount_positive"
  CHECK (
    "amount" > 0
  );

ALTER TABLE "e_ajo_contribution_periods"
  ADD CONSTRAINT "chk_e_ajo_contribution_periods_amounts_non_negative"
  CHECK (
    "contributionDue" >= 0 AND
    "contributionPaid" >= 0 AND
    "penaltyAssessed" >= 0 AND
    "penaltyPaid" >= 0 AND
    "penaltyWaived" >= 0
  );

ALTER TABLE "e_ajo_penalty_accruals"
  ADD CONSTRAINT "chk_e_ajo_penalty_accruals_amount_positive"
  CHECK (
    "amount" > 0
  );

