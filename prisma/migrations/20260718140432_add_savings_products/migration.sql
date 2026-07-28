-- AlterTable
ALTER TABLE "savings" ADD COLUMN     "productId" TEXT;

-- CreateTable
CREATE TABLE "savings_products" (
    "id" TEXT NOT NULL,
    "type" "SavingsType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rates" TEXT NOT NULL,
    "badge" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "savings_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "savings_productId_idx" ON "savings"("productId");

-- AddForeignKey
ALTER TABLE "savings_products" ADD CONSTRAINT "savings_products_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings" ADD CONSTRAINT "savings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "savings_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
