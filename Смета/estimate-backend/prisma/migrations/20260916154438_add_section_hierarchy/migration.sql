-- AlterTable
ALTER TABLE "CatalogMaterial" ADD COLUMN     "materialSectionId" TEXT;

-- AlterTable
ALTER TABLE "CatalogSection" ADD COLUMN     "parentId" TEXT;

-- CreateTable
CREATE TABLE "MaterialSection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "MaterialSection_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CatalogSection" ADD CONSTRAINT "CatalogSection_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CatalogSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialSection" ADD CONSTRAINT "MaterialSection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialSection" ADD CONSTRAINT "MaterialSection_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MaterialSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogMaterial" ADD CONSTRAINT "CatalogMaterial_materialSectionId_fkey" FOREIGN KEY ("materialSectionId") REFERENCES "MaterialSection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
