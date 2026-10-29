-- CreateEnum
CREATE TYPE "GuaranteeState" AS ENUM ('PENDING', 'CONSENTED', 'DECLINED', 'WITHDRAWN_BEFORE_ACTIVATION', 'AWAITING_RECONSENT', 'REPLACED', 'RELEASED');

-- CreateEnum
CREATE TYPE "GuaranteeType" AS ENUM ('LOAN', 'EAJO');

-- CreateEnum
CREATE TYPE "BorrowerOfferDecision" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "guarantee_reservations" (
    "id" TEXT NOT NULL,
    "guaranteeType" "GuaranteeType" NOT NULL,
    "guarantorId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "loanId" TEXT,
    "eajoMemberId" TEXT,
    "requestedAmount" DECIMAL(15,2) NOT NULL,
    "consentedAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "reservedAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "state" "GuaranteeState" NOT NULL DEFAULT 'PENDING',
    "termMonths" INTEGER,
    "monthlyInterestRate" DECIMAL(7,4),
    "penaltyTerms" TEXT,
    "termsVersion" INTEGER NOT NULL DEFAULT 1,
    "consentedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "replacedAt" TIMESTAMP(3),
    "replacementGuaranteeId" TEXT,
    "releasedAt" TIMESTAMP(3),
    "evidenceCloudinaryPublicId" TEXT,
    "evidenceDocumentId" TEXT,
    "evidenceSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guarantee_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "borrower_offer_acceptances" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "borrowerId" TEXT NOT NULL,
    "decision" "BorrowerOfferDecision" NOT NULL DEFAULT 'PENDING',
    "offeredPrincipal" DECIMAL(15,2) NOT NULL,
    "offeredTermMonths" INTEGER NOT NULL,
    "offeredMonthlyInterestRate" DECIMAL(7,4) NOT NULL,
    "totalScheduledRepayment" DECIMAL(15,2) NOT NULL,
    "monthlyInstalment" DECIMAL(15,2) NOT NULL,
    "termsVersion" INTEGER NOT NULL DEFAULT 1,
    "decidedAt" TIMESTAMP(3),
    "evidenceCloudinaryPublicId" TEXT,
    "evidenceDocumentId" TEXT,
    "evidenceSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "borrower_offer_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guarantee_reservations_guarantorId_state_idx" ON "guarantee_reservations"("guarantorId", "state");

-- CreateIndex
CREATE INDEX "guarantee_reservations_applicantId_state_idx" ON "guarantee_reservations"("applicantId", "state");

-- CreateIndex
CREATE INDEX "guarantee_reservations_loanId_state_idx" ON "guarantee_reservations"("loanId", "state");

-- CreateIndex
CREATE INDEX "guarantee_reservations_eajoMemberId_state_idx" ON "guarantee_reservations"("eajoMemberId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "guarantee_reservations_loanId_guarantorId_key" ON "guarantee_reservations"("loanId", "guarantorId");

-- CreateIndex
CREATE UNIQUE INDEX "guarantee_reservations_eajoMemberId_guarantorId_key" ON "guarantee_reservations"("eajoMemberId", "guarantorId");

-- CreateIndex
CREATE UNIQUE INDEX "borrower_offer_acceptances_loanId_key" ON "borrower_offer_acceptances"("loanId");

-- CreateIndex
CREATE INDEX "borrower_offer_acceptances_borrowerId_decision_idx" ON "borrower_offer_acceptances"("borrowerId", "decision");

-- AddForeignKey
ALTER TABLE "guarantee_reservations" ADD CONSTRAINT "guarantee_reservations_guarantorId_fkey" FOREIGN KEY ("guarantorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guarantee_reservations" ADD CONSTRAINT "guarantee_reservations_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guarantee_reservations" ADD CONSTRAINT "guarantee_reservations_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guarantee_reservations" ADD CONSTRAINT "guarantee_reservations_eajoMemberId_fkey" FOREIGN KEY ("eajoMemberId") REFERENCES "e_ajo_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrower_offer_acceptances" ADD CONSTRAINT "borrower_offer_acceptances_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrower_offer_acceptances" ADD CONSTRAINT "borrower_offer_acceptances_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints for guarantee reservations and borrower offer acceptances (PR P2-04)
ALTER TABLE "guarantee_reservations"
  ADD CONSTRAINT "chk_guarantee_reservations_amounts_non_negative"
  CHECK (
    "requestedAmount" >= 0 AND
    "consentedAmount" >= 0 AND
    "reservedAmount" >= 0
  );

ALTER TABLE "borrower_offer_acceptances"
  ADD CONSTRAINT "chk_borrower_offer_acceptances_amounts_positive"
  CHECK (
    "offeredPrincipal" > 0 AND
    "totalScheduledRepayment" > 0 AND
    "monthlyInstalment" > 0
  );

