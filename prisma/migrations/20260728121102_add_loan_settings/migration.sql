-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LoanStatus" ADD VALUE 'ACCEPTED';
ALTER TYPE "LoanStatus" ADD VALUE 'DECLINED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SavingsMaturity" ADD VALUE 'ONE_MONTH';
ALTER TYPE "SavingsMaturity" ADD VALUE 'THREE_MONTHS';

-- AlterTable
ALTER TABLE "savings_products" ADD COLUMN     "interestRate12Months" DECIMAL(65,30),
ADD COLUMN     "interestRate1Month" DECIMAL(65,30),
ADD COLUMN     "interestRate3Months" DECIMAL(65,30),
ADD COLUMN     "interestRate6Months" DECIMAL(65,30);

-- CreateTable
CREATE TABLE "LoanSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "interestRate" DECIMAL(5,2) NOT NULL DEFAULT 5.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "LoanSettings_pkey" PRIMARY KEY ("id")
);
