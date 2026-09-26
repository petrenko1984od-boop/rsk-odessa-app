/*
  Warnings:

  - A unique constraint covering the columns `[number]` on the table `Vedomost` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `number` to the `Vedomost` table without a default value. This is not possible if the table is not empty.
  - Added the required column `numberSeq` to the `Vedomost` table without a default value. This is not possible if the table is not empty.
  - Added the required column `numberYear` to the `Vedomost` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Vedomost" ADD COLUMN     "limitMgmt" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "limitMgmtBase" TEXT NOT NULL DEFAULT 'both',
ADD COLUMN     "limitOrg" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "limitOrgBase" TEXT NOT NULL DEFAULT 'both',
ADD COLUMN     "limitProfit" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "limitProfitBase" TEXT NOT NULL DEFAULT 'both',
ADD COLUMN     "limitRisks" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "limitRisksBase" TEXT NOT NULL DEFAULT 'both',
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "number" TEXT NOT NULL,
ADD COLUMN     "numberSeq" INTEGER NOT NULL,
ADD COLUMN     "numberYear" INTEGER NOT NULL,
ADD COLUMN     "vatBase" TEXT NOT NULL DEFAULT 'both',
ADD COLUMN     "vatPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "VedomostItemMaterial" ADD COLUMN     "consumption" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "CompanySettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "address" TEXT,
    "logoUrl" TEXT,
    "defaultNotes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanySettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanySettings_userId_key" ON "CompanySettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Vedomost_number_key" ON "Vedomost"("number");

-- AddForeignKey
ALTER TABLE "CompanySettings" ADD CONSTRAINT "CompanySettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
