-- AlterTable
ALTER TABLE "CatalogMaterial" ADD COLUMN     "isCustomerSupplied" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "VedomostItemMaterial" ADD COLUMN     "isCustomerSupplied" BOOLEAN NOT NULL DEFAULT false;
