-- CreateEnum
CREATE TYPE "PaymentDueStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "FollowUp" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdById" TEXT;

-- CreateTable
CREATE TABLE "PaymentDue" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "visitDate" DATE NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" "PaymentDueStatus" NOT NULL DEFAULT 'PENDING',
    "payToken" TEXT NOT NULL,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastRemindedAt" TIMESTAMP(3),
    "claimedPaidAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentDue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentDue_payToken_key" ON "PaymentDue"("payToken");

-- CreateIndex
CREATE INDEX "PaymentDue_doctorId_status_idx" ON "PaymentDue"("doctorId", "status");

-- CreateIndex
CREATE INDEX "PaymentDue_profileId_idx" ON "PaymentDue"("profileId");

-- CreateIndex
CREATE INDEX "FollowUp_profileId_idx" ON "FollowUp"("profileId");

-- CreateIndex
CREATE INDEX "FollowUp_dueDate_idx" ON "FollowUp"("dueDate");

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PatientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentDue" ADD CONSTRAINT "PaymentDue_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PatientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
