-- CreateTable
CREATE TABLE "stored_files" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "secureUrl" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL DEFAULT 'image',
    "deliveryType" TEXT NOT NULL DEFAULT 'authenticated',
    "format" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "originalFilename" TEXT,
    "uploadedById" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "associatedType" TEXT,
    "associatedId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_publicId_key" ON "stored_files"("publicId");

-- CreateIndex
CREATE INDEX "stored_files_ownerUserId_idx" ON "stored_files"("ownerUserId");

-- CreateIndex
CREATE INDEX "stored_files_uploadedById_idx" ON "stored_files"("uploadedById");

-- CreateIndex
CREATE INDEX "stored_files_associatedType_associatedId_idx" ON "stored_files"("associatedType", "associatedId");

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
