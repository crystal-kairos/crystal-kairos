-- CreateEnum
CREATE TYPE "SubmissionPurpose" AS ENUM ('SAVINGS_FIRST_DEPOSIT', 'SAVINGS_PERIOD', 'SAVINGS_DEPOSIT', 'LOAN_REPAYMENT', 'LOAN_SETTLEMENT', 'EAJO_CONTRIBUTION', 'WALLET_TOPUP', 'FEE');

-- CreateEnum
CREATE TYPE "PaymentSubmissionStatus" AS ENUM ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CONFIRMED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('RECEIPT', 'WALLET', 'RECOVERY', 'SUSPENSE_MATCH');

-- CreateEnum
CREATE TYPE "AllocationTargetType" AS ENUM ('SAVINGS', 'LOAN', 'EAJO', 'WALLET', 'FEE');

-- CreateEnum
CREATE TYPE "PaymentComponentType" AS ENUM ('PENALTY', 'INTEREST', 'PRINCIPAL', 'CONTRIBUTION', 'WALLET_TOPUP', 'FEE');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- CreateEnum
CREATE TYPE "DisbursementPurpose" AS ENUM ('LOAN_DISBURSEMENT', 'SAVINGS_PAYOUT', 'EAJO_PAYOUT', 'WALLET_WITHDRAWAL', 'MEMBER_SETTLEMENT');

-- CreateEnum
CREATE TYPE "DisbursementStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('LOAN_APPLICATION', 'MEMBERSHIP');

-- CreateEnum
CREATE TYPE "FeeStatus" AS ENUM ('PENDING', 'PAID', 'WAIVED');

-- CreateTable
CREATE TABLE "payment_submissions" (
    "id" TEXT NOT NULL,
    "submissionNumber" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "purpose" "SubmissionPurpose",
    "receivingBankAccountId" TEXT,
    "claimedAmount" DECIMAL(15,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "bankReference" TEXT,
    "payerAccountName" TEXT,
    "receiptFileId" TEXT,
    "fileHash" TEXT,
    "narration" TEXT,
    "status" "PaymentSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "rejectionReason" TEXT,
    "resubmissionOfId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "valueDate" DATE,

    CONSTRAINT "payment_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_targets" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "targetType" "AllocationTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetPeriodId" TEXT,
    "requestedAmount" DECIMAL(15,2) NOT NULL,

    CONSTRAINT "submission_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "paymentNumber" TEXT NOT NULL,
    "source" "PaymentSource" NOT NULL DEFAULT 'RECEIPT',
    "submissionId" TEXT,
    "memberId" TEXT NOT NULL,
    "totalConfirmedAmount" DECIMAL(15,2) NOT NULL,
    "valueDate" DATE NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" TEXT NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "targetType" "AllocationTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "periodId" TEXT,
    "componentType" "PaymentComponentType" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "status" "AllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reversedAt" TIMESTAMP(3),
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursements" (
    "id" TEXT NOT NULL,
    "disbursementNumber" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "purpose" "DisbursementPurpose" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "bankReference" TEXT,
    "valueDate" DATE NOT NULL,
    "status" "DisbursementStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "disbursedById" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "journalEntryId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disbursements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_assessments" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "feeType" "FeeType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "status" "FeeStatus" NOT NULL DEFAULT 'PENDING',
    "paymentAllocationId" TEXT,
    "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_submissions_submissionNumber_key" ON "payment_submissions"("submissionNumber");

-- CreateIndex
CREATE INDEX "payment_submissions_memberId_status_idx" ON "payment_submissions"("memberId", "status");

-- CreateIndex
CREATE INDEX "payment_submissions_paidOn_idx" ON "payment_submissions"("paidOn");

-- CreateIndex
CREATE INDEX "payment_submissions_fileHash_idx" ON "payment_submissions"("fileHash");

-- CreateIndex
CREATE INDEX "payment_submissions_bankReference_claimedAmount_paidOn_idx" ON "payment_submissions"("bankReference", "claimedAmount", "paidOn");

-- CreateIndex
CREATE INDEX "submission_targets_submissionId_idx" ON "submission_targets"("submissionId");

-- CreateIndex
CREATE INDEX "submission_targets_targetType_targetId_idx" ON "submission_targets"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_paymentNumber_key" ON "payments"("paymentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payments_submissionId_key" ON "payments"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_memberId_valueDate_idx" ON "payments"("memberId", "valueDate");

-- CreateIndex
CREATE INDEX "payments_valueDate_idx" ON "payments"("valueDate");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payment_allocations_paymentId_idx" ON "payment_allocations"("paymentId");

-- CreateIndex
CREATE INDEX "payment_allocations_targetType_targetId_periodId_idx" ON "payment_allocations"("targetType", "targetId", "periodId");

-- CreateIndex
CREATE INDEX "payment_allocations_status_idx" ON "payment_allocations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "disbursements_disbursementNumber_key" ON "disbursements"("disbursementNumber");

-- CreateIndex
CREATE UNIQUE INDEX "disbursements_idempotencyKey_key" ON "disbursements"("idempotencyKey");

-- CreateIndex
CREATE INDEX "disbursements_recipientUserId_status_idx" ON "disbursements"("recipientUserId", "status");

-- CreateIndex
CREATE INDEX "disbursements_valueDate_idx" ON "disbursements"("valueDate");

-- CreateIndex
CREATE INDEX "fee_assessments_memberId_status_idx" ON "fee_assessments"("memberId", "status");

-- CreateIndex
CREATE INDEX "fee_assessments_feeType_targetId_idx" ON "fee_assessments"("feeType", "targetId");

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_receivingBankAccountId_fkey" FOREIGN KEY ("receivingBankAccountId") REFERENCES "society_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_receiptFileId_fkey" FOREIGN KEY ("receiptFileId") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_resubmissionOfId_fkey" FOREIGN KEY ("resubmissionOfId") REFERENCES "payment_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_targets" ADD CONSTRAINT "submission_targets_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "payment_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "payment_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_disbursedById_fkey" FOREIGN KEY ("disbursedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_assessments" ADD CONSTRAINT "fee_assessments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_assessments" ADD CONSTRAINT "fee_assessments_paymentAllocationId_fkey" FOREIGN KEY ("paymentAllocationId") REFERENCES "payment_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
