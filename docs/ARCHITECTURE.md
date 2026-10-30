# Architecture

> **Implementation notes (as built, 10 Oct 2026):**
> - **Inbound messages are processed in memory, per sender in order,** inside the webhook request (bounded at 9 s). Raw text never enters any queue or table.
> - **Scheduled jobs use a small Postgres table (`ScheduledJob`) instead of pg-boss.** It is still Postgres-only with no Redis, but tests can drive it with a fake clock.
> - The repo uses **npm workspaces** (no pnpm).
> - Model and speech adapters live in **`packages/ai`**.
> - Language models run on **Bedrock Mantle** (see docs/MODEL_SELECTION.md).
> - The admin model setting is stored in **`SystemConfig`**.

## 1. Overview
```
                    ┌──────────────────────────── one Node.js process (apps/server) ───────────────────────────┐
WhatsApp Cloud API ─┼─▶ POST /webhook ──verify sig──dedupe wamid──▶ pg-boss job "inbound"                         │
   (Meta)           │                                                   │                                        │
      ▲             │                                                   ▼                                        │
      │             │   ConversationService ──▶ core/extract (STT + LLM, in-memory) ──▶ structured fields only   │
      │ send        │        │                                                                                   │
      └─────────────┼── wa.Sender ◀── core/copy (replies) ◀── core/state-machine ◀── SlotService / QueueService  │
                    │                                                   │                                        │
                    │   POST /flow ──decrypt──▶ FlowService (live slots) ┘                                        │
                    │   REST /api/* ──▶ services      SSE /api/events ──▶ dashboard + TV                         │
                    │   static: apps/web export (dashboard, /display, /dev/simulator)                            │
                    │   pg-boss workers: reminders, alerts, no-show sweep, overflow timeout, purge, daily code   │
                    └───────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                                ▼
                                                     PostgreSQL 16 (data + pg-boss schema)
External processors (AWS ap-south-1 by default): Amazon Bedrock (extraction: gpt-oss-120b, escalating to Claude Haiku 4.5 India profile), Amazon Transcribe (speech-to-text), Razorpay (Phase 2)
```

## 2. Repository layout
```
clinicq/
├─ CLAUDE.md  README.md  package.json  tsconfig.base.json  .env.example
├─ apps/
│  ├─ server/                 Fastify app (single process)
│  │  ├─ src/main.ts          boot: env → db → pg-boss → routes → static
│  │  ├─ src/routes/          webhook.ts flow.ts api/*.ts events.ts auth.ts dev.ts
│  │  ├─ src/services/        conversation.ts slots.ts booking.ts queue.ts walkin.ts staff.ts
│  │  │                       notify.ts consent.ts privacy.ts audit.ts sse.ts
│  │  ├─ src/jobs/            inbound.ts reminders.ts alerts.ts noShowSweep.ts overflowTimeout.ts
│  │  │                       purge.ts dailyCode.ts dailySummary.ts holdSweep.ts
│  │  └─ test/
│  └─ web/                    Next.js (output: 'export')
│     ├─ app/(dash)/queue  app/(dash)/appointments  app/(dash)/settings  app/(dash)/reports
│     ├─ app/display          TV page
│     ├─ app/login
│     └─ app/dev/simulator    WhatsApp simulator (only built when NEXT_PUBLIC_DEV_TOOLS=1)
├─ packages/
│  ├─ core/                   pure logic, no I/O
│  │  ├─ slots/               generateSlots, findNearSlots, isBookable
│  │  ├─ queue/               transitions, pickNext, computeEta, positions
│  │  ├─ conversation/        state machine (states, events, reducer)
│  │  ├─ extract/             types + zod schema + Extractor interface + rule-based fallback
│  │  ├─ copy/                en.ts hi.ts hinglish.ts + render(id, lang, vars) with variants
│  │  ├─ safety/              emergency keyword matcher, health-content heuristics
│  │  ├─ time/                IST helpers, relative-date resolution ("kal", "parso", "next Monday")
│  │  └─ log/                 redacting logger (pino)
│  ├─ db/                     prisma/schema.prisma, migrations, seed.ts, crypto (encrypt/hash)
│  └─ wa/                     CloudApiClient, MockWhatsApp, message builders with limit checks,
│                             template registry, flowCrypto.ts, webhook types (zod)
└─ docs/
```

## 3. Key flows (sequence)

### 3.1 Inbound message → reply
```mermaid
sequenceDiagram
  participant WA as WhatsApp Cloud API
  participant WH as /webhook
  participant J as pg-boss "inbound"
  participant C as ConversationService
  participant X as Extractor (STT+LLM)
  participant S as Slot/Booking/Queue services
  WA->>WH: POST (X-Hub-Signature-256)
  WH->>WH: verify HMAC, parse (zod), dedupe wamid (ProcessedMessage insert)
  WH->>X: text: extract(text) inline (memory only)
  X-->>WH: {intent, date, timePref, forWhom, name, phone, lang, flags}
  WH->>J: enqueue {wamid, from, structured fields | buttonId | mediaId}  (never raw text)
  WH-->>WA: 200 OK
  J->>C: handle(event)
  C->>X: voice only: download audio to memory → STT → extract
  C->>S: query/act (findNearSlots, hold, confirm, status…)
  C->>WA: send reply (copy bank, session message or template)
```
**Note on raw text and the job queue:** pg-boss persists job payloads in Postgres, so **raw text must not go in the job.** The webhook route runs extraction **before** it enqueues, with a 5 s budget:
1. Text messages: the webhook handler calls `extract()` inline. The job payload is the *structured result* plus the button or list reply ID.
2. Voice notes: the handler enqueues `{wamid, mediaId}` only. The job downloads the audio from Meta into memory, transcribes it, extracts, and continues. The media ID isn't sensitive content.
3. Interactive replies (button or list IDs) carry no free text and are enqueued as-is.

The webhook still returns 200 promptly. If extraction exceeds the budget, the route returns 200 and finishes in-process (fire-and-forget with a retry-safe dedupe key). This rule is covered by the boundary tests.

### 3.2 Booking with smart suggest → Flow fallback
```mermaid
sequenceDiagram
  participant P as Patient
  participant B as Bot
  participant SL as SlotService
  P->>B: "kal shaam 6 baje ke aas paas mummy ke liye"
  B->>SL: findNearSlots(date=tomorrow, time=18:00, window=±60)
  alt near slots found
    SL-->>B: [17:50, 18:10]
    B->>P: buttons [5:50 PM][6:10 PM][See all slots]
    P->>B: tap 6:10 PM
    B->>SL: hold(slot, 5 min) → confirm()
  else none near
    B->>P: Flow message "Choose a date & time" (CTA)
    P->>B: (inside Flow) data_exchange: date selected
    B->>P: (Flow endpoint) slots for date
    P->>B: complete → nfm_reply {date, slot}
    B->>SL: confirm(slot) (re-validate)
  end
  B->>P: confirmation (token A-4)
```

### 3.3 Walk-in overflow
```mermaid
sequenceDiagram
  participant P as Patient
  participant B as Bot
  participant St as Staff (WhatsApp/dashboard)
  P->>B: WALKIN DRS-4821
  B->>B: quota full → create WalkinOverflowRequest(PENDING), schedule timeout job (5 min)
  B->>P: "checking with reception…"
  B->>St: staff_walkin_overflow [Yes, adjust][No] + SSE popup
  alt Yes
    St->>B: Yes → "Which time?" → "7:50 PM" | End of queue
    B->>B: issue W-12 (expectedAt 19:50), WAITING
    B->>P: token + ETA
  else No or timeout
    B->>P: next booking slots [..][..][See all slots] + Call clinic
  end
```

### 3.4 Consultation completed (one tap)
`POST /api/queue/complete` → transaction: IN_CONSULT→COMPLETED; NEXT→IN_CONSULT; pickNext(waiting)→NEXT. Then audit, SSE `queue.updated`, and notify the new NEXT and IN_CONSULT patients plus whoever crossed the turn-near threshold. ETA recompute is broadcast to the TV.

### 3.5 Clinics on their own numbers (multi-clinic)
One server runs the shared **demo number** (Demo Studio switches which demo clinic it serves) and any number of **customer clinics** on their own WhatsApp numbers (`Clinic.ownNumber`, connected with Embedded Signup, `WaConnection`).
- **Scope** (`apps/server/src/scope.ts`, AsyncLocalStorage): every unit of work runs in a clinic scope, set once where it enters: the webhook (by `metadata.phone_number_id`), dashboard requests (the signed-in staff member's clinic), the TV display (its key), the booking and pay pages (their tokens), and jobs (the scope they were scheduled in, kept as `clinicScope` in the payload). `clinicInfo(ctx)`, `ctx.wa` (sends from the clinic's own number), live events (`EventBus` delivers only within the clinic) and patient accounts follow the scope without being passed around.
- **Patients** belong to a number: `PatientAccount.channel` is `"demo"` or the customer clinic's id, unique with `phoneHash`. A person who messages two clinics has two separate accounts, consents and histories.
- **Staff** WhatsApp commands work only on their own clinic's number. Dashboard routes that take an id check that it belongs to the signed-in clinic (else 404).
- **Disconnected** numbers are ignored (`scopeForNumber` → "ignore"); Demo Studio can't activate, reset or delete a customer clinic.
- **Clinic status** (`Clinic.status`, set in the admin portal): a SUSPENDED or ARCHIVED customer clinic does nothing. Its number is ignored (`scopeForNumber`), `ctx.wa` won't send for it, the scheduler drops its due jobs, its dashboard and public pages answer 403 `clinic_paused`, and its logins get no code. ARCHIVED also disconnects its number; deleting erases all its rows (`services/customers.ts`).
- **Two portals.** A clinic's portal (`/`): `StaffUser.role` DOCTOR or CLINIC_ADMIN manage it (a clinic admin never touches doctor logins), STAFF run the desk (`services/staff.ts` holds every login rule). Incolo's admin portal (`/admin`, `/api/admin/*`): `IncoloAdmin` rows (owners from `INCOLO_ADMIN_PHONES`, more added in the portal); each active admin also has a doctor login in the shared-number (demo) clinic, which is how they sign in and demo. Admins see a customer clinic's details and logins, never its patients.
- Embedded Signup (`services/embeddedSignup.ts`): the browser gets a one-time code from Meta's pop-up; the server exchanges it for the clinic's business token (stored encrypted, never sent back), checks the number is in the account, subscribes the account's webhooks, registers the number (not for coexistence), saves the connection, then a job submits the templates and checks their approval. Disconnect unsubscribes and wipes the token at once; the ids go after 30 days.

## 4. Conversation state
- `ConversationState` row per account: `{state, context(jsonb), expiresAt}`. Context holds only structured fields: `pendingIntent, profileId, date, timePref, offeredSlots[], heldAppointmentId, lang`.
- TTL is 30 min since the last message. After that, a new message starts a new conversation (consent and number are remembered).
- The state machine is in `packages/core/conversation`. It is a pure reducer `(state, event, ctx) → {state, effects[]}`. Effects (send message, hold slot…) are executed by the service. This keeps it unit-testable.

## 5. Background jobs (pg-boss)
| Job | Schedule | Purpose |
|---|---|---|
| `reminder.24h` / `reminder.sameDay` | scheduled per appointment at confirm (cancel on change) | BK-11 |
| `holdSweep` | every 1 min | release expired slot holds |
| `overflowTimeout` | per request at +N min | WI-03 timeout |
| `noShowSweep` | per session end + grace | BK-13 |
| `dailyCode` | 00:00 IST | rotate walk-in QR code |
| `dailySummary` | session end + 15 min (last session) | RP-01 |
| `purge` | 02:30 IST daily | retention (DATA_POLICY §5) |
| `templateHealth` | hourly | check template status and phone quality rating; alert the doctor |

## 6. Security
- **Transport:** HTTPS only (Caddy). HSTS. The webhook and Flow endpoint are public; everything else needs a session.
- **Webhook:** HMAC SHA-256 of the raw body with `META_APP_SECRET`, compared in constant time. Reject if it doesn't match.
- **Flow endpoint:** RSA-OAEP (SHA-256) private key for the AES key; AES-128-GCM payload; response encrypted with the inverted IV (see WHATSAPP_INTEGRATION §6). Private key stored in a file readable only by the service user.
- **Field encryption:** `packages/db/crypto`. AES-256-GCM with `DATA_KEY` (32 bytes, base64) for phone, contactPhone and names. HMAC-SHA256 with `HASH_PEPPER` for `phoneHash`. Key rotation: a `keyVersion` column, with re-encryption done by a script.
- **AuthZ:** roles DOCTOR (all) and STAFF (no settings or staff management, no data deletion). The display page uses a long random `displayKey` (read-only, token + first name only).
- **Rate limits:** per WhatsApp number 20 msgs/min (beyond that, ignore with one polite notice). OTP 5/hour per number. API 100 req/min per session.
- **Audit:** `AuditLog` for every staff action, setting change, data export and deletion.
- **Backups:** nightly `pg_dump` encrypted with `age`, copied off-site, kept 14 days. Monthly restore test (DEPLOYMENT §6).

## 7. Configuration
All configuration comes from env, validated with zod at boot (`apps/server/src/env.ts`). `.env.example`:
```
NODE_ENV=development
PORT=8080
PUBLIC_BASE_URL=https://clinic.example.in
DATABASE_URL=postgresql://clinicq:***@localhost:5432/clinicq
CLINIC_TZ=Asia/Kolkata

WA_MODE=mock                    # mock | cloud
META_APP_SECRET=
META_VERIFY_TOKEN=
WA_ACCESS_TOKEN=                # system-user permanent token
WA_PHONE_NUMBER_ID=
WA_BUSINESS_ACCOUNT_ID=
WA_GRAPH_VERSION=v23.0          # set to the current Graph API version at build time
WA_FLOW_ID_BOOKING=
FLOW_PRIVATE_KEY_PATH=/etc/clinicq/flow_private.pem
FLOW_PRIVATE_KEY_PASSPHRASE=

AWS_REGION=ap-south-1           # credentials: EC2 instance role (prod) / AWS profile (dev)
EXTRACTOR_PRIMARY=bedrock:openai.gpt-oss-120b-1:0
EXTRACTOR_ESCALATION=anthropic-bedrock:in.anthropic.claude-haiku-4-5-20251001-v1:0
EXTRACTOR_TIMEOUT_MS=3500
EXTRACTOR_MIN_CONFIDENCE=0.7
OPENAI_COMPAT_BASE_URL=          # self-hosted open-source model server (optional)
OPENAI_COMPAT_API_KEY=
ANTHROPIC_API_KEY=               # only for the anthropic: adapter
STT_PROVIDER=transcribe         # transcribe | sarvam | openai-compat | mock
STT_FALLBACK=                   # optional second provider
SARVAM_API_KEY=
BACKUP_S3_BUCKET=

DATA_KEY=                       # base64 32 bytes
HASH_PEPPER=                    # base64 32 bytes
SESSION_SECRET=

PAYMENTS_ENABLED=false
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```
Clinic-level settings (sessions, quotas, windows, toggles) live in the DB (`Clinic.settings`), editable from the dashboard, and are not env.

## 8. Extensibility
- `doctorId` is on every Session, Appointment, QueueEntry and TokenCounter, so adding a second doctor later is a UI and settings change, not a schema rewrite.
- Language: add `packages/core/copy/<lang>.ts` plus a template translation, and register it in `LANGS`.
- Speech-to-text and extractor are behind interfaces, so providers can be swapped.
