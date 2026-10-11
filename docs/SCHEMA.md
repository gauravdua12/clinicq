# Database schema (Prisma draft)

PostgreSQL 16+. Fields marked `// enc` are AES-256-GCM ciphertext (base64) produced by `packages/db/crypto`. **Adding any field requires checking DATA_POLICY §2 first.** The CI schema guard rejects free-text fields named like reason/notes/symptom/etc.

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

model Clinic {
  id            String   @id @default(cuid())
  name          String
  addressShort  String
  addressFull   String
  mapsUrl       String?
  lat           Float?
  lng           Float?
  phone         String              // clinic public phone (not patient data)
  code          String   @unique    // e.g. "DRS" used in walk-in QR
  noticeUrl     String
  grievanceContact Json             // {name, email, phone}
  settings      Json                // see ClinicSettings (zod) below
  createdAt     DateTime @default(now())
  doctors       Doctor[]
  staff         StaffUser[]
}

model Doctor {
  id            String   @id @default(cuid())
  clinicId      String
  clinic        Clinic   @relation(fields: [clinicId], references: [id])
  displayName   String              // "Dr. Sharma"
  qualification String?
  delayMinutes  Int      @default(0)          // live "running late" offset (today)
  pauseUntil    DateTime?
  sessions      Session[]
  closures      Closure[]
}

model Session {
  id            String   @id @default(cuid())
  doctorId      String
  doctor        Doctor   @relation(fields: [doctorId], references: [id])
  weekday       Int                 // 0=Sun … 6=Sat
  label         String              // "Morning" / "Evening"
  startTime     String              // "10:00" (clinic TZ)
  endTime       String              // "13:00"
  slotMinutes   Int
  walkinQuota   Int
  active        Boolean  @default(true)
  @@index([doctorId, weekday])
}

model Closure {
  id            String   @id @default(cuid())
  doctorId      String
  doctor        Doctor   @relation(fields: [doctorId], references: [id])
  date          DateTime @db.Date
  sessionId     String?             // null = whole day
  label         String?             // "Holiday", "Leave" (no patient data)
  createdById   String
  createdAt     DateTime @default(now())
}

model BlockedSlot {
  id            String   @id @default(cuid())
  doctorId      String
  slotStart     DateTime
  createdById   String
  @@unique([doctorId, slotStart])
}

model StaffUser {
  id            String   @id @default(cuid())
  clinicId      String
  clinic        Clinic   @relation(fields: [clinicId], references: [id])
  name          String
  waPhone       String              // enc
  phoneHash     String   @unique
  role          StaffRole
  onDuty        Boolean  @default(true)
  active        Boolean  @default(true)
}
enum StaffRole { DOCTOR STAFF }

model PatientAccount {
  id                String   @id @default(cuid())
  waPhone           String              // enc (WhatsApp wa_id)
  phoneHash         String   @unique    // HMAC(wa_id)
  waProfileName     String?             // enc
  language          Lang     @default(en)
  numberConfirmedAt DateTime?
  optedOutAt        DateTime?
  lastInboundAt     DateTime?           // 24h window
  lastActivityAt    DateTime @default(now())
  keyVersion        Int      @default(1)
  createdAt         DateTime @default(now())
  profiles          PatientProfile[]
  consents          ConsentRecord[]
}
enum Lang { en hi hinglish }

model PatientProfile {
  id            String   @id @default(cuid())
  accountId     String?             // null for staff-added name-only walk-ins
  account       PatientAccount? @relation(fields: [accountId], references: [id], onDelete: Cascade)
  name          String              // enc
  relation      Relation @default(SELF)
  yearOfBirth   Int?
  gender        Gender?
  contactPhone  String?             // enc (alternate number)
  createdAt     DateTime @default(now())
  appointments  Appointment[]
  queueEntries  QueueEntry[]
}
enum Relation { SELF MOTHER FATHER SPOUSE SON DAUGHTER SIBLING GRANDPARENT OTHER }
enum Gender { MALE FEMALE OTHER UNDISCLOSED }

model ConsentRecord {
  id            String   @id @default(cuid())
  accountId     String
  account       PatientAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  noticeVersion String
  language      Lang
  channel       String   @default("whatsapp")
  givenAt       DateTime @default(now())
  withdrawnAt   DateTime?
}

model Appointment {
  id            String   @id @default(cuid())
  doctorId      String
  profileId     String?             // null after anonymisation
  profile       PatientProfile? @relation(fields: [profileId], references: [id], onDelete: SetNull)
  sessionId     String
  slotStart     DateTime            // UTC
  slotKey       String?  @unique    // "<doctorId>:<ISO>" while HELD/BOOKED/ARRIVED; NULL otherwise
  status        ApptStatus
  holdExpiresAt DateTime?
  visitType     VisitType?
  token         String?             // "A-4"
  source        ApptSource @default(WHATSAPP)
  feeStatus     FeeStatus @default(NOT_REQUIRED)
  rescheduledFromId String?
  bookedAt      DateTime?
  cancelledAt   DateTime?
  cancelledBy   CancelActor?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)
  queueEntry    QueueEntry?
  @@index([doctorId, slotStart])
  @@index([profileId, status])
}
enum ApptStatus { HELD BOOKED ARRIVED COMPLETED CANCELLED NO_SHOW }
enum VisitType { NEW FOLLOW_UP REPORT_SHOW }
enum ApptSource { WHATSAPP STAFF }
enum FeeStatus { NOT_REQUIRED PENDING PAID REFUNDED FAILED }
enum CancelActor { PATIENT CLINIC SYSTEM }

model QueueEntry {
  id            String   @id @default(cuid())
  doctorId      String
  sessionId     String
  date          DateTime @db.Date   // session instance date (clinic TZ)
  profileId     String?
  profile       PatientProfile? @relation(fields: [profileId], references: [id], onDelete: SetNull)
  appointmentId String?  @unique
  appointment   Appointment? @relation(fields: [appointmentId], references: [id])
  displayName   String?             // enc; for staff-added name-only walk-ins
  source        QueueSource         // A | W
  token         String
  state         QueueState
  arrivedAt     DateTime
  expectedAt    DateTime?           // staff-assigned time (overflow)
  lateArrival   Boolean  @default(false)
  manualRank    Float?              // set by move up/down
  promotedAt    DateTime?
  consultStartedAt DateTime?
  completedAt   DateTime?
  turnNearSentAt DateTime?
  version       Int      @default(0)
  @@index([doctorId, date, sessionId, state])
}
enum QueueSource { A W }
enum QueueState { WAITING NEXT IN_CONSULT COMPLETED NO_SHOW CANCELLED }

model TokenCounter {
  doctorId   String
  date       DateTime @db.Date
  sessionId  String
  series     String               // "A" | "W" | "N"
  value      Int      @default(0)
  @@id([doctorId, date, sessionId, series])
}

model WalkinOverflowRequest {
  id           String   @id @default(cuid())
  doctorId     String
  sessionId    String
  date         DateTime @db.Date
  profileId    String
  status       OverflowStatus @default(PENDING)
  decidedById  String?
  decidedAt    DateTime?
  assignedTime DateTime?
  endOfQueue   Boolean  @default(false)
  createdAt    DateTime @default(now())
  expiresAt    DateTime
}
enum OverflowStatus { PENDING APPROVED DECLINED TIMED_OUT }

model DailyWalkinCode {
  clinicId  String
  date      DateTime @db.Date
  code      String
  @@id([clinicId, date])
}

model FollowUp {           // Phase 2
  id        String   @id @default(cuid())
  profileId String
  doctorId  String
  dueDate   DateTime @db.Date
  remindedAt DateTime?
  bookedAppointmentId String?
}

model Payment {            // Phase 2
  id            String   @id @default(cuid())
  appointmentId String?  @unique
  provider      String              // razorpay | cashfree
  providerOrderId String @unique
  amountPaise   Int
  status        String              // created | paid | failed | refunded
  refundId      String?
  createdAt     DateTime @default(now())
}

model ConversationState {
  accountId  String   @id
  state      String
  context    Json                   // structured fields only (see ARCHITECTURE §4)
  expiresAt  DateTime
  updatedAt  DateTime @updatedAt
}

model FlowToken {
  token      String   @id           // random 32 bytes base64url
  accountId  String
  profileId  String?
  expiresAt  DateTime
}

model ProcessedMessage {
  wamid      String   @id
  receivedAt DateTime @default(now())
}

model MessageLog {
  id         String   @id @default(cuid())
  accountId  String?
  direction  Direction
  kind       String                 // copyId | template name | "inbound:text" | "inbound:audio" | "inbound:image"…
  wamid      String?  @unique
  status     String?                // sent|delivered|read|failed
  errorCode  Int?
  createdAt  DateTime @default(now())
}
enum Direction { IN OUT }

model AuditLog {
  id        String   @id @default(cuid())
  actorType String                  // STAFF | DOCTOR | SYSTEM | PATIENT
  actorId   String?
  action    String                  // "queue.advance", "appointment.cancel", "settings.update", "data.erase"…
  entity    String
  entityId  String?
  diff      Json?                   // logistics fields only
  at        DateTime @default(now())
}

model DataRequest {
  id        String   @id @default(cuid())
  accountHash String                // phoneHash at time of request (no content)
  type      String                  // ACCESS | ERASURE | CORRECTION | OPT_OUT
  status    String                  // DONE | FLAGGED
  at        DateTime @default(now())
}

model StaffSession {
  id        String   @id            // random
  staffId   String
  expiresAt DateTime
  createdAt DateTime @default(now())
}

model OtpChallenge {
  phoneHash String   @id
  codeHash  String
  attempts  Int      @default(0)
  expiresAt DateTime
}
```

## ClinicSettings (zod, stored in `Clinic.settings`)
```ts
{
  windowDays: 7, cutoffMinutes: 60, lateGraceMinutes: 15, noShowGraceMinutes: 30,
  nearWindowMinutes: 60, holdMinutes: 5, maxActiveBookingsPerProfile: 2,
  earlyArrivalMinutes: 60, earlyCheckInMinutes: 30,
  walkinOverflowTimeoutMinutes: 5, turnNearThreshold: 2, maxConsecutiveWalkins: 2,
  tokenSeries: { singleSeries: false, appointmentPrefix: "A", walkinPrefix: "W",
                 appointmentTokenMode: "slotIndex" },
  display: { showFirstName: true, voiceCallout: true, showQr: true },
  flowsEnabled: true,
  languages: ["en","hi","hinglish"],
  payments: { enabled: false, amountPaise: 0, paymentHoldMinutes: 10,
              refundIfCancelledHoursBefore: 4, policyText: "" },
  retention: { messageLogDays: 90, visitAnonymiseDays: 180, inactiveProfileMonths: 12, auditDays: 365 },
  emergencyKeywordsExtra: [],
  noticeVersion: "2026-10-v1"
}
```

## Migration notes
- `slotKey` uniqueness gives one-booking-per-slot. Postgres allows multiple NULLs, so released keys don't conflict.
- Add a CHECK via raw SQL migration: `QueueEntry` has at most one `NEXT` and one `IN_CONSULT` per `(doctorId, date, sessionId)`, using partial unique indexes:
  `CREATE UNIQUE INDEX one_next ON "QueueEntry"("doctorId","date","sessionId") WHERE state='NEXT';`
  `CREATE UNIQUE INDEX one_inconsult ON "QueueEntry"("doctorId","date","sessionId") WHERE state='IN_CONSULT';`
- pg-boss creates its own `pgboss` schema at startup.
