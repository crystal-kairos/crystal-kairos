/*
  Warnings:

  - Made the column `rates` on table `savings_products` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "savings_products" ALTER COLUMN "rates" SET NOT NULL,
ALTER COLUMN "rates" SET DEFAULT 'Flexible Rates';
