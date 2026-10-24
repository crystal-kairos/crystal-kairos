-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('COOPERATIVE_CASH', 'SUSPENSE_UNIDENTIFIED', 'MEMBER_WALLET_LIABILITY', 'SAVINGS_PRINCIPAL_LIABILITY', 'SAVINGS_INTEREST_PAYABLE', 'SAVINGS_INTEREST_EXPENSE', 'LOAN_RECEIVABLE_PRINCIPAL', 'LOAN_INTEREST_RECEIVABLE', 'LOAN_INTEREST_INCOME', 'LOAN_PENALTY_RECEIVABLE', 'EAJO_CONTRIBUTION_LIABILITY', 'EAJO_ADVANCE_RECEIVABLE', 'EAJO_PENALTY_RECEIVABLE', 'EAJO_EARLY_SLOT_INCOME', 'PENALTY_INCOME', 'FEE_INCOME', 'WAIVER_EXPENSE', 'BAD_DEBT_EXPENSE', 'MEMBER_SETTLEMENT_PAYABLE', 'REVERSAL_SHORTFALL_RECEIVABLE', 'OPENING_BALANCE_EQUITY', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WalletWithdrawalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedById" TEXT,
    "reversalOfId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountType" "LedgerAccountType" NOT NULL,
    "memberId" TEXT,
    "accountRefType" TEXT,
    "accountRefId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "debit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_withdrawals" (
    "id" TEXT NOT NULL,
    "withdrawalNumber" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "status" "WalletWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "wallet_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" "UserRole",
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeState" JSONB,
    "afterState" JSONB,
    "metadata" JSONB,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "isSingleOperator" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_idempotencyKey_key" ON "journal_entries"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversalOfId_key" ON "journal_entries"("reversalOfId");

-- CreateIndex
CREATE INDEX "journal_entries_sourceType_sourceId_idx" ON "journal_entries"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "journal_entries_effectiveDate_idx" ON "journal_entries"("effectiveDate");

-- CreateIndex
CREATE INDEX "journal_entries_postedAt_idx" ON "journal_entries"("postedAt");

-- CreateIndex
CREATE INDEX "journal_lines_accountType_accountRefId_idx" ON "journal_lines"("accountType", "accountRefId");

-- CreateIndex
CREATE INDEX "journal_lines_memberId_accountType_idx" ON "journal_lines"("memberId", "accountType");

-- CreateIndex
CREATE INDEX "journal_lines_journalEntryId_idx" ON "journal_lines"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_withdrawals_withdrawalNumber_key" ON "wallet_withdrawals"("withdrawalNumber");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_withdrawals_idempotencyKey_key" ON "wallet_withdrawals"("idempotencyKey");

-- CreateIndex
CREATE INDEX "wallet_withdrawals_memberId_status_idx" ON "wallet_withdrawals"("memberId", "status");

-- CreateIndex
CREATE INDEX "audit_events_entityType_entityId_idx" ON "audit_events"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_events_actorId_timestamp_idx" ON "audit_events"("actorId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_events_timestamp_idx" ON "audit_events"("timestamp");

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_withdrawals" ADD CONSTRAINT "wallet_withdrawals_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_withdrawals" ADD CONSTRAINT "wallet_withdrawals_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_withdrawals" ADD CONSTRAINT "wallet_withdrawals_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw SQL CHECK constraint (PR P2-02, §2.12):
-- Debit and credit must be non-negative, and exactly one of debit or credit must be positive per journal line.
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "chk_journal_lines_debit_credit_valid"
  CHECK (
    (debit >= 0 AND credit >= 0) AND
    (
      (debit > 0 AND credit = 0) OR
      (credit > 0 AND debit = 0)
    )
  );

-- Withdrawal amount must be strictly positive
ALTER TABLE "wallet_withdrawals"
  ADD CONSTRAINT "chk_wallet_withdrawals_amount_positive"
  CHECK (amount > 0);
