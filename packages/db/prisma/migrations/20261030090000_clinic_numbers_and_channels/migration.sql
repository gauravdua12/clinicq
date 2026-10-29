-- DropIndex
DROP INDEX "PatientAccount_phoneHash_key";

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "ownNumber" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PatientAccount" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'demo';

-- CreateTable
CREATE TABLE "WaConnection" (
    "clinicId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "displayPhone" TEXT,
    "verifiedName" TEXT,
    "token" TEXT NOT NULL,
    "pin" TEXT,
    "status" TEXT NOT NULL,
    "connectedBy" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3),
    "health" JSONB,

    CONSTRAINT "WaConnection_pkey" PRIMARY KEY ("clinicId")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaConnection_phoneNumberId_key" ON "WaConnection"("phoneNumberId");

-- CreateIndex
CREATE INDEX "PatientAccount_phoneHash_idx" ON "PatientAccount"("phoneHash");

-- CreateIndex
CREATE UNIQUE INDEX "PatientAccount_channel_phoneHash_key" ON "PatientAccount"("channel", "phoneHash");

-- AddForeignKey
ALTER TABLE "WaConnection" ADD CONSTRAINT "WaConnection_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

