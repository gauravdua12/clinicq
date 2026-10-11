-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('DOCTOR', 'STAFF');

-- CreateEnum
CREATE TYPE "Lang" AS ENUM ('en', 'hi', 'hinglish');

-- CreateEnum
CREATE TYPE "Relation" AS ENUM ('SELF', 'MOTHER', 'FATHER', 'SPOUSE', 'SON', 'DAUGHTER', 'SIBLING', 'GRANDPARENT', 'OTHER');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "ApptStatus" AS ENUM ('HELD', 'BOOKED', 'ARRIVED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "VisitType" AS ENUM ('NEW', 'FOLLOW_UP', 'REPORT_SHOW');

-- CreateEnum
CREATE TYPE "ApptSource" AS ENUM ('WHATSAPP', 'STAFF');

-- CreateEnum
CREATE TYPE "FeeStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PAID', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "CancelActor" AS ENUM ('PATIENT', 'CLINIC', 'SYSTEM');

-- CreateEnum
CREATE TYPE "QueueSource" AS ENUM ('A', 'W');

-- CreateEnum
CREATE TYPE "QueueState" AS ENUM ('WAITING', 'NEXT', 'IN_CONSULT', 'COMPLETED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OverflowStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "Clinic" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressShort" TEXT NOT NULL,
    "addressFull" TEXT NOT NULL,
    "mapsUrl" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "noticeUrl" TEXT NOT NULL,
    "grievanceContact" JSONB NOT NULL,
    "settings" JSONB NOT NULL,
    "displayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doctor" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "qualification" TEXT,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "delayDate" DATE,
    "pauseUntil" TIMESTAMP(3),

    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "slotMinutes" INTEGER NOT NULL,
    "walkinQuota" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Closure" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sessionId" TEXT,
    "label" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Closure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedSlot" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "slotStart" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "BlockedSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffUser" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "waPhone" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "onDuty" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientAccount" (
    "id" TEXT NOT NULL,
    "waPhone" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "waProfileName" TEXT,
    "language" "Lang" NOT NULL DEFAULT 'en',
    "numberConfirmedAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientProfile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "relation" "Relation" NOT NULL DEFAULT 'SELF',
    "yearOfBirth" INTEGER,
    "gender" "Gender",
    "contactPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "language" "Lang" NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "givenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "profileId" TEXT,
    "sessionId" TEXT NOT NULL,
    "slotStart" TIMESTAMP(3) NOT NULL,
    "slotKey" TEXT,
    "status" "ApptStatus" NOT NULL,
    "holdExpiresAt" TIMESTAMP(3),
    "visitType" "VisitType",
    "token" TEXT,
    "source" "ApptSource" NOT NULL DEFAULT 'WHATSAPP',
    "feeStatus" "FeeStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "rescheduledFromId" TEXT,
    "bookedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" "CancelActor",
    "reminder24Sent" BOOLEAN NOT NULL DEFAULT false,
    "reminderDaySent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueEntry" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "profileId" TEXT,
    "appointmentId" TEXT,
    "displayName" TEXT,
    "source" "QueueSource" NOT NULL,
    "token" TEXT NOT NULL,
    "state" "QueueState" NOT NULL,
    "arrivedAt" TIMESTAMP(3) NOT NULL,
    "slotStart" TIMESTAMP(3),
    "expectedAt" TIMESTAMP(3),
    "lateArrival" BOOLEAN NOT NULL DEFAULT false,
    "manualRank" DOUBLE PRECISION,
    "promotedAt" TIMESTAMP(3),
    "consultStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "turnNearSentAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenCounter" (
    "doctorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sessionId" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TokenCounter_pkey" PRIMARY KEY ("doctorId","date","sessionId","series")
);

-- CreateTable
CREATE TABLE "WalkinOverflowRequest" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "profileId" TEXT NOT NULL,
    "accountId" TEXT,
    "status" "OverflowStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "assignedTime" TIMESTAMP(3),
    "endOfQueue" BOOLEAN NOT NULL DEFAULT false,
    "awaitingTimeFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalkinOverflowRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyWalkinCode" (
    "clinicId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "code" TEXT NOT NULL,

    CONSTRAINT "DailyWalkinCode_pkey" PRIMARY KEY ("clinicId","date")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "remindedAt" TIMESTAMP(3),
    "bookedAppointmentId" TEXT,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "refundId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationState" (
    "accountId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationState_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "FlowToken" (
    "token" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "profileId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlowToken_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "ProcessedMessage" (
    "wamid" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMessage_pkey" PRIMARY KEY ("wamid")
);

-- CreateTable
CREATE TABLE "MessageLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "direction" "Direction" NOT NULL,
    "kind" TEXT NOT NULL,
    "wamid" TEXT,
    "status" TEXT,
    "errorCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "diff" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataRequest" (
    "id" TEXT NOT NULL,
    "accountHash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffSession" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "phoneHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("phoneHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_code_key" ON "Clinic"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_displayKey_key" ON "Clinic"("displayKey");

-- CreateIndex
CREATE INDEX "Session_doctorId_weekday_idx" ON "Session"("doctorId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedSlot_doctorId_slotStart_key" ON "BlockedSlot"("doctorId", "slotStart");

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_phoneHash_key" ON "StaffUser"("phoneHash");

-- CreateIndex
CREATE UNIQUE INDEX "PatientAccount_phoneHash_key" ON "PatientAccount"("phoneHash");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_slotKey_key" ON "Appointment"("slotKey");

-- CreateIndex
CREATE INDEX "Appointment_doctorId_slotStart_idx" ON "Appointment"("doctorId", "slotStart");

-- CreateIndex
CREATE INDEX "Appointment_profileId_status_idx" ON "Appointment"("profileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "QueueEntry_appointmentId_key" ON "QueueEntry"("appointmentId");

-- CreateIndex
CREATE INDEX "QueueEntry_doctorId_date_sessionId_state_idx" ON "QueueEntry"("doctorId", "date", "sessionId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_appointmentId_key" ON "Payment"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerOrderId_key" ON "Payment"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageLog_wamid_key" ON "MessageLog"("wamid");

-- CreateIndex
CREATE INDEX "MessageLog_accountId_createdAt_idx" ON "MessageLog"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- AddForeignKey
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Closure" ADD CONSTRAINT "Closure_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffUser" ADD CONSTRAINT "StaffUser_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientProfile" ADD CONSTRAINT "PatientProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PatientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PatientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PatientProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PatientProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Queue invariants: at most one NEXT and one IN_CONSULT per session instance (docs/QUEUE_ENGINE.md §4.1)
CREATE UNIQUE INDEX "QueueEntry_one_next" ON "QueueEntry"("doctorId", "date", "sessionId") WHERE "state" = 'NEXT';
CREATE UNIQUE INDEX "QueueEntry_one_in_consult" ON "QueueEntry"("doctorId", "date", "sessionId") WHERE "state" = 'IN_CONSULT';
