-- CreateEnum
CREATE TYPE "ClinicStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "StaffRole" ADD VALUE 'CLINIC_ADMIN';

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "status" "ClinicStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "statusChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "IncoloAdmin" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "waPhone" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "owner" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncoloAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IncoloAdmin_phoneHash_key" ON "IncoloAdmin"("phoneHash");
