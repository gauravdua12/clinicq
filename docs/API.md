# HTTP API

Base: `PUBLIC_BASE_URL`. JSON everywhere. Auth means an httpOnly `sid` cookie (StaffSession). Errors use the shape `{error: {code, message}}`. All mutating endpoints accept `If-Match: <version>` for optimistic locking and return 409 `STALE` when it doesn't match.

## Public
| Method | Path | Purpose |
|---|---|---|
| GET | `/webhook` | Meta verification |
| POST | `/webhook` | WhatsApp events (signature verified) |
| POST | `/flow` | WhatsApp Flow data endpoint (encrypted) |
| POST | `/payments/webhook` | Razorpay (Phase 2, signature verified) |
| GET | `/privacy` | privacy notice (current version, EN/HI) |
| GET | `/healthz` | `{ok, db, jobs}` (no data) |
| GET | `/api/pay/:token` | the patient's pay page data: clinic, amount, visit date, status, UPI link and QR. No patient details; 404 if unknown or cancelled |

## Auth
| Method | Path | Body / Notes |
|---|---|---|
| POST | `/api/auth/otp` | `{phone}` → sends `staff_login_otp` if the phone belongs to active staff (always returns 200, to avoid enumeration) |
| POST | `/api/auth/verify` | `{phone, code}` → sets the `sid` cookie |
| POST | `/api/auth/logout` | |
| GET | `/api/me` | `{name, role}` |

## Queue (role: STAFF+)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/queue/today?session=<id>` | `{session, current: Entry?, next: Entry?, waiting: Entry[], counts, avgConsultMin, delayMin, pauseUntil}` |
| POST | `/api/queue/advance` | Consultation completed (composite) |
| POST | `/api/queue/start` | NEXT → IN_CONSULT |
| POST | `/api/queue/:id/no-show` | |
| POST | `/api/queue/:id/cancel` | |
| POST | `/api/queue/:id/move` | `{direction: "up"|"down"|"top"}` |
| POST | `/api/queue/:id/re-add` | NO_SHOW → WAITING (end) |
| POST | `/api/queue/:id/undo` | IN_CONSULT → NEXT (≤ 2 min) |
| POST | `/api/queue/walkin` | `{name, phone?}` → staff-added walk-in (bypasses quota) |
| POST | `/api/queue/broadcast` | `{type: "late"|"pause"|"resume", minutes?}` |
| POST | `/api/queue/close-today` | `{confirm: true}` → bulk cancel and notify |
| POST | `/api/overflow/:id/decide` | `{decision: "yes"|"no", time?: "19:50", endOfQueue?: boolean}` |

`Entry` = `{id, token, source, displayName (first name + last initial), relationHint?, state, arrivedAt, slotStart?, expectedAt?, lateArrival, etaMin?, version}`. **Phone numbers are never returned in list views.**

## Appointments (role: STAFF+)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/appointments?from=&to=` | list (masked phone) |
| GET | `/api/slots?date=` | free/booked/blocked slots for staff booking |
| POST | `/api/appointments` | `{name, phone, slotStart, visitType}` → book on behalf, sends confirmation |
| POST | `/api/appointments/:id/arrive` | check-in → QueueEntry WAITING |
| POST | `/api/appointments/:id/cancel` | notifies the patient |
| POST | `/api/appointments/:id/reschedule` | `{slotStart}` |
| POST | `/api/slots/block` / `/api/slots/unblock` | `{slotStart}` |

## Follow-ups and payments due (role: STAFF+)
- `GET /api/followups` → upcoming follow-ups (from 14 days ago): `{id, name, phone (masked), dueDate, status: scheduled|reminded|booked}`.
- `POST /api/followups {appointmentId | queueEntryId, dueDate}` → `{id, dueDate, remindOn}`. Replaces the patient's open follow-up. Errors: `bad_date`, `no_whatsapp`, `not_found`.
- `DELETE /api/followups/:id` → cancels it (no reminder).
- `GET /api/payments` → `{upiConfigured, rows: [{id, name, phone (masked), visitDate, amount, status, remindersSent, claimedPaid, paidAt}]}` (pending, plus paid in the last 30 days).
- `POST /api/payments {appointmentId | queueEntryId, amount (₹)}` → sends the first message now → `{id, whatsappSent}`. Errors: `no_upi` (set the UPI ID first), `no_whatsapp`.
- `POST /api/payments/:id/paid` (sends the receipt) · `/remind` (once per 12 h, else `too_soon`) · `/cancel`.

## Settings (role: DOCTOR)
| Method | Path | Purpose |
|---|---|---|
| GET/PUT | `/api/settings/clinic` | Clinic profile + ClinicSettings (zod-validated) |
| GET/PUT | `/api/settings/sessions` | weekly sessions |
| GET/POST/DELETE | `/api/settings/closures` | POST returns `{affectedAppointments}`, then `?confirm=1` applies + notifies |
| GET/POST/PATCH | `/api/settings/staff` | add, deactivate, toggle on duty |
| GET | `/api/settings/qr` | today's walk-in QR (PNG) |
| GET | `/api/settings/display-key` / POST rotate | |

## Reports (Phase 2, role: DOCTOR)
`GET /api/reports/summary?from=&to=` → aggregates only (counts, averages, peak hours).

## Display (no session; `key` required)
`GET /api/display/state?key=` → `{inConsult: {token, firstName?}, next, waiting: [..5], banner, qrDataUrl?}`

## Live updates (SSE)
`GET /api/events` (auth) and `GET /api/display/events?key=` (display key).
| Event | Payload |
|---|---|
| `queue.updated` | full `queue/today` snapshot (small, simpler than diffs) |
| `appointment.changed` | `{id, status}` |
| `overflow.requested` | `{id, name, sessionLabel, expiresAt}` → dashboard popup |
| `overflow.resolved` | `{id, status, by}` |
| `doctor.status` | `{delayMin, pauseUntil}` |
| `system.alert` | `{kind: "template_paused"|"quality_low"|"stt_down"|"llm_down", message}` |
Heartbeat comment every 25 s. Clients reconnect with `Last-Event-ID`.

## Dev only (`NODE_ENV!=production`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/dev/simulate` | `{from, name, type, text?|buttonId?|voiceText?|image?}` → builds and signs a Meta-format webhook, then posts it to `/webhook` |
| GET | `/dev/outbox` (SSE) | outbound messages from MockWhatsApp |
| POST | `/dev/clock` | `{now}`: fake clock for scenario tests (also used by jobs) |
| POST | `/dev/reset` | reseed demo data |
