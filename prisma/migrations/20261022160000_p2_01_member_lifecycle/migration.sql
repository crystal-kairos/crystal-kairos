-- CreateEnum
CREATE TYPE "UserDeactivationReason" AS ENUM ('ADMIN_ACTION', 'EXITED', 'DECEASED', 'OTHER');

-- DropForeignKey
ALTER TABLE "bank_accounts" DROP CONSTRAINT "bank_accounts_userId_fkey";

-- DropForeignKey
ALTER TABLE "e_ajo" DROP CONSTRAINT "e_ajo_userId_fkey";

-- DropForeignKey
ALTER TABLE "e_ajo_members" DROP CONSTRAINT "e_ajo_members_groupId_fkey";

-- DropForeignKey
ALTER TABLE "e_ajo_members" DROP CONSTRAINT "e_ajo_members_userId_fkey";

-- DropForeignKey
ALTER TABLE "loans" DROP CONSTRAINT "loans_userId_fkey";

-- DropForeignKey
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_userId_fkey";

-- DropForeignKey
ALTER TABLE "next_of_kins" DROP CONSTRAINT "next_of_kins_userId_fkey";

-- DropForeignKey
ALTER TABLE "savings" DROP CONSTRAINT "savings_productId_fkey";

-- DropForeignKey
ALTER TABLE "savings" DROP CONSTRAINT "savings_userId_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_bankAccountId_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_eAjoId_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_eAjoMemberId_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_loanId_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_savingsId_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_userId_fkey";

-- DropForeignKey
ALTER TABLE "user_info" DROP CONSTRAINT "user_info_userId_fkey";

-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "bankCode" TEXT,
ADD COLUMN     "isVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "e_ajo" ALTER COLUMN "contributionAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "feePercentage" SET DATA TYPE DECIMAL(7,4),
ALTER COLUMN "feeAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "totalExpectedPayout" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "netPayoutAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "currentBalance" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "totalContributed" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "payoutDate" SET DATA TYPE DATE,
ALTER COLUMN "startDate" SET DATA TYPE DATE,
ALTER COLUMN "endDate" SET DATA TYPE DATE;

-- AlterTable
ALTER TABLE "e_ajo_groups" ALTER COLUMN "startDate" SET DATA TYPE DATE,
ALTER COLUMN "endDate" SET DATA TYPE DATE;

-- AlterTable
ALTER TABLE "e_ajo_members" ALTER COLUMN "feePercentage" SET DATA TYPE DECIMAL(7,4),
ALTER COLUMN "payoutDate" SET DATA TYPE DATE;

-- AlterTable
ALTER TABLE "loans" ALTER COLUMN "requestedAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "approvedAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "interestRate" SET DATA TYPE DECIMAL(7,4),
ALTER COLUMN "applicationFee" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "outstandingBalance" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "totalRepaid" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "defaultPenalty" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "repaymentStartDate" SET DATA TYPE DATE,
ALTER COLUMN "repaymentEndDate" SET DATA TYPE DATE,
ALTER COLUMN "actualRepaymentDate" SET DATA TYPE DATE;

-- AlterTable
ALTER TABLE "memberships" ALTER COLUMN "membershipFee" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "renewalFee" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "expiryDate" SET DATA TYPE DATE,
ALTER COLUMN "lastRenewalDate" SET DATA TYPE DATE;

-- AlterTable
ALTER TABLE "savings" ALTER COLUMN "targetAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "interestRate" SET DATA TYPE DECIMAL(7,4),
ALTER COLUMN "currentBalance" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "accruedInterest" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "totalDeposited" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "expectedMaturityAmount" SET DATA TYPE DECIMAL(15,2),
ALTER COLUMN "startDate" SET DATA TYPE DATE,
ALTER COLUMN "maturityDate" SET DATA TYPE DATE;

-- AlterTable
ALTER TABLE "savings_products" ALTER COLUMN "interestRate12Months" SET DATA TYPE DECIMAL(7,4),
ALTER COLUMN "interestRate1Month" SET DATA TYPE DECIMAL(7,4),
ALTER COLUMN "interestRate3Months" SET DATA TYPE DECIMAL(7,4),
ALTER COLUMN "interestRate6Months" SET DATA TYPE DECIMAL(7,4);

-- AlterTable
ALTER TABLE "user_info" ALTER COLUMN "dateOfBirth" SET DATA TYPE DATE;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedById" TEXT,
DROP COLUMN "deactivationReason",
ADD COLUMN     "deactivationReason" "UserDeactivationReason";

-- CreateTable
CREATE TABLE "privacy_consents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "privacy_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "society_bank_accounts" (
    "id" TEXT NOT NULL,
    "bankCode" TEXT,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "society_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "privacy_consents_userId_idx" ON "privacy_consents"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_consents_userId_noticeVersion_key" ON "privacy_consents"("userId", "noticeVersion");

-- CreateIndex
CREATE INDEX "society_bank_accounts_isActive_idx" ON "society_bank_accounts"("isActive");

-- CreateIndex
CREATE INDEX "bank_accounts_userId_idx" ON "bank_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_userId_bankCode_accountNumber_key" ON "bank_accounts"("userId", "bankCode", "accountNumber");

-- CreateIndex
CREATE INDEX "bank_accounts_bankCode_accountNumber_idx" ON "bank_accounts"("bankCode", "accountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "user_info_phoneNumber_key" ON "user_info"("phoneNumber");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_deactivatedById_fkey" FOREIGN KEY ("deactivatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_consents" ADD CONSTRAINT "privacy_consents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "society_bank_accounts" ADD CONSTRAINT "society_bank_accounts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_info" ADD CONSTRAINT "user_info_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "next_of_kins" ADD CONSTRAINT "next_of_kins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_ajo" ADD CONSTRAINT "e_ajo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_ajo_members" ADD CONSTRAINT "e_ajo_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "e_ajo_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_ajo_members" ADD CONSTRAINT "e_ajo_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_eAjoId_fkey" FOREIGN KEY ("eAjoId") REFERENCES "e_ajo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_eAjoMemberId_fkey" FOREIGN KEY ("eAjoMemberId") REFERENCES "e_ajo_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_savingsId_fkey" FOREIGN KEY ("savingsId") REFERENCES "savings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings" ADD CONSTRAINT "savings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings" ADD CONSTRAINT "savings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "savings_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sequence for sequential CK-000001 memberNumber
CREATE SEQUENCE IF NOT EXISTS membership_number_seq START WITH 1;

-- CHECK constraints from P2-00
ALTER TABLE "transactions"
  ADD CONSTRAINT "chk_transactions_amount_positive"
  CHECK ("amount" > 0);

ALTER TABLE "loans"
  ADD CONSTRAINT "chk_loans_duration_months"
  CHECK ("duration" >= 1 AND "duration" <= 12),
  ADD CONSTRAINT "chk_loans_interest_percent"
  CHECK ("interestRate" >= 0 AND "interestRate" <= 100);

ALTER TABLE "savings"
  ADD CONSTRAINT "chk_savings_interest_percent"
  CHECK ("interestRate" >= 0 AND "interestRate" <= 100);

ALTER TABLE "e_ajo_groups"
  ADD CONSTRAINT "chk_eajo_groups_duration_months"
  CHECK ("duration" IN ('FOUR_MONTHS', 'SIX_MONTHS', 'TWELVE_MONTHS'));
