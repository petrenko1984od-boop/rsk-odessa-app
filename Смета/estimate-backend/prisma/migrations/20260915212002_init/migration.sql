-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogWork" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "priceWorker" DOUBLE PRECISION NOT NULL,
    "priceClient" DOUBLE PRECISION NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "CatalogWork_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogMaterial" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "pricePurchase" DOUBLE PRECISION NOT NULL,
    "priceClient" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "CatalogMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkMaterial" (
    "id" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "consumption" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "WorkMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vedomost" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "object" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT,

    CONSTRAINT "Vedomost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VedomostSection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "vedomostId" TEXT NOT NULL,

    CONSTRAINT "VedomostSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VedomostItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priceWorker" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priceClient" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sectionId" TEXT NOT NULL,
    "catalogWorkId" TEXT,

    CONSTRAINT "VedomostItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VedomostItemMaterial" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pricePurchase" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priceClient" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "itemId" TEXT NOT NULL,
    "catalogMaterialId" TEXT,

    CONSTRAINT "VedomostItemMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "WorkMaterial_workId_materialId_key" ON "WorkMaterial"("workId", "materialId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogWork" ADD CONSTRAINT "CatalogWork_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogMaterial" ADD CONSTRAINT "CatalogMaterial_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkMaterial" ADD CONSTRAINT "WorkMaterial_workId_fkey" FOREIGN KEY ("workId") REFERENCES "CatalogWork"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkMaterial" ADD CONSTRAINT "WorkMaterial_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "CatalogMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vedomost" ADD CONSTRAINT "Vedomost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vedomost" ADD CONSTRAINT "Vedomost_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VedomostSection" ADD CONSTRAINT "VedomostSection_vedomostId_fkey" FOREIGN KEY ("vedomostId") REFERENCES "Vedomost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VedomostItem" ADD CONSTRAINT "VedomostItem_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "VedomostSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VedomostItem" ADD CONSTRAINT "VedomostItem_catalogWorkId_fkey" FOREIGN KEY ("catalogWorkId") REFERENCES "CatalogWork"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VedomostItemMaterial" ADD CONSTRAINT "VedomostItemMaterial_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "VedomostItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VedomostItemMaterial" ADD CONSTRAINT "VedomostItemMaterial_catalogMaterialId_fkey" FOREIGN KEY ("catalogMaterialId") REFERENCES "CatalogMaterial"("id") ON DELETE SET NULL ON UPDATE CASCADE;
