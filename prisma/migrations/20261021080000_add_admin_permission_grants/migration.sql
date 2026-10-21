-- CreateEnum
CREATE TYPE "AdminPermission" AS ENUM (
    'MEMBERS_READ',
    'MEMBERS_CREATE',
    'MEMBERS_APPROVE',
    'PROFILE_CHANGES_REVIEW',
    'SOCIETY_SETTINGS_MANAGE',
    'SAVINGS_READ',
    'SAVINGS_MANAGE',
    'SAVINGS_PAYMENTS_REVIEW',
    'LOANS_READ',
    'LOANS_REVIEW',
    'LOANS_DISBURSE',
    'LOAN_SETTINGS_MANAGE',
    'GUARANTEES_REVIEW',
    'EAJO_READ',
    'EAJO_MANAGE',
    'EAJO_PAYMENTS_REVIEW',
    'EAJO_PAYOUTS_MANAGE',
    'TRANSACTIONS_READ',
    'TRANSACTIONS_REVIEW',
    'PAYMENTS_REVERSE',
    'WALLET_MANAGE',
    'WALLET_WITHDRAWALS_REVIEW',
    'RECOVERY_MANAGE',
    'RECOVERY_EXECUTE',
    'PENALTY_WAIVE',
    'RECONCILIATION_MANAGE',
    'SETTLEMENTS_MANAGE',
    'POLICY_NOTICES_MANAGE',
    'NOTIFICATIONS_MANAGE',
    'AUDIT_READ',
    'STAFF_MANAGE'
);

-- AlterTable
ALTER TABLE "users" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "admin_permission_grants" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "permission" "AdminPermission" NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_permission_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_permission_grants_grantedById_idx" ON "admin_permission_grants"("grantedById");

-- CreateIndex
CREATE UNIQUE INDEX "admin_permission_grants_adminUserId_permission_key" ON "admin_permission_grants"("adminUserId", "permission");

-- AddForeignKey
ALTER TABLE "admin_permission_grants" ADD CONSTRAINT "admin_permission_grants_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_permission_grants" ADD CONSTRAINT "admin_permission_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
