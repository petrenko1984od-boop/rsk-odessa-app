/*
  Warnings:

  - You are about to drop the column `limitMgmt` on the `Vedomost` table. All the data in the column will be lost.
  - You are about to drop the column `limitMgmtBase` on the `Vedomost` table. All the data in the column will be lost.
  - You are about to drop the column `limitOrg` on the `Vedomost` table. All the data in the column will be lost.
  - You are about to drop the column `limitOrgBase` on the `Vedomost` table. All the data in the column will be lost.
  - You are about to drop the column `limitProfit` on the `Vedomost` table. All the data in the column will be lost.
  - You are about to drop the column `limitProfitBase` on the `Vedomost` table. All the data in the column will be lost.
  - You are about to drop the column `limitRisks` on the `Vedomost` table. All the data in the column will be lost.
  - You are about to drop the column `limitRisksBase` on the `Vedomost` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Vedomost" DROP COLUMN "limitMgmt",
DROP COLUMN "limitMgmtBase",
DROP COLUMN "limitOrg",
DROP COLUMN "limitOrgBase",
DROP COLUMN "limitProfit",
DROP COLUMN "limitProfitBase",
DROP COLUMN "limitRisks",
DROP COLUMN "limitRisksBase";

-- CreateTable
CREATE TABLE "VedomostLimit" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "base" TEXT NOT NULL DEFAULT 'both',
    "order" INTEGER NOT NULL DEFAULT 0,
    "vedomostId" TEXT NOT NULL,

    CONSTRAINT "VedomostLimit_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "VedomostLimit" ADD CONSTRAINT "VedomostLimit_vedomostId_fkey" FOREIGN KEY ("vedomostId") REFERENCES "Vedomost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
