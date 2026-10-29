# Build plan: milestones and tasks

Work top to bottom. Each task lists the PRD IDs it covers. **Definition of done (every task):** code + tests pass (`npm test`, `npm run test:boundary`), with no lint or type errors, and the docs are updated if behaviour differs from the spec. Then tick the box and commit.
Ask the user before deviating from an approved decision (README "Key approved decisions").

## Build status (10 Oct 2026)
| Milestone | Status |
|---|---|
| M0 Scaffold | ✅ npm workspaces, Prisma 7 + migrations, crypto, redacting logger, seed |
| M1 Slot engine · M2 Queue engine | ✅ worked examples E1–E14 as unit tests |
| M3 WhatsApp layer + simulator | ✅ webhook (signature, dedupe, per-sender order, rate limit), mock, `/dev/simulator` |
| M4 Conversation core · M5 Booking | ✅ copy bank EN/HI/Hinglish, consent, number confirm, family profiles, smart-suggest → Flow → list, race, family same-slot, reschedule/cancel |
| M6 AI understanding | ✅ model-agnostic cascade; **14-model bake-off** (docs/MODEL_SELECTION.md); Voxtral voice notes |
| M7 WhatsApp Flow | ✅ endpoint + crypto + Flow JSON (`packages/wa/flows/booking.json`). Upload to Meta at go-live |
| M8 Queue ops, walk-ins, board, TV | ✅ QR daily code, staff overflow (yes/time/no/timeout), staff WhatsApp commands, dashboard board, TV display |
| M9 Jobs + privacy | ✅ reminders, no-show sweep, early check-in, purge, my data / delete / stop |
| M10 Auth, appointments, settings | ✅ WhatsApp OTP login, appointments tab, settings incl. **admin model switch with live smoke test** |
| M11 Hardening / go-live | ◐ boundary + integration suites ✅, prod bundle ✅. **Pending:** Playwright UI tests, load test, breach runbook, EC2 deployment, Meta number + templates (need your accounts) |
| Phase 2 | ◐ Reports tab ✅. Booking fee (Razorpay), follow-ups, daily summary job, regional language: not started |

## M0: Scaffold
- [ ] T0.1 npm workspaces: `apps/server`, `apps/web`, `packages/{core,db,wa}`; strict tsconfig; ESLint + Prettier; Vitest at the root.
- [ ] T0.2 `env.ts` with zod validation (ARCHITECTURE §7); `.env.example`.
- [ ] T0.3 Prisma schema from `SCHEMA.md` + raw-SQL partial indexes; `db:migrate`, `db:seed` (Dr. Sharma demo clinic, Mon–Sat sessions, 2 staff, display key).
- [ ] T0.4 `packages/db/crypto`: encrypt/decrypt (AES-256-GCM), `phoneHash` (HMAC), mask helpers + tests.
- [ ] T0.5 `packages/core/log`: pino logger with redaction (DATA_POLICY §4.3) + tests.
- [ ] T0.6 Fastify boot: `/healthz`, static serving of the web export, pg-boss start, graceful shutdown.
- [ ] T0.7 Boundary test harness skeleton (`TESTING.md §5`) and the schema-guard test.
**Verify:** `npm run dev` starts; `/healthz` returns ok.

## M1: Time and slot engine (pure)
- [ ] T1.1 `core/time`: IST helpers, relative date resolution utilities (for the rule-based fallback), formatting ("Sat 11 Oct", "6:10 PM", Hindi numerals off).
- [ ] T1.2 `core/slots`: `generateSlots`, `isBookable`, `findNearSlots` (QUEUE_ENGINE §2). BK-02, BK-09.
- [ ] T1.3 Tests for worked examples E1–E6, E14 + property tests (no slot outside a session; near ≤ 2; chronological order).

## M2: Queue engine (pure)
- [ ] T2.1 `core/queue`: transition table, `pickNext`, `positions`, `computeEta`, alert decisions (QUEUE_ENGINE §4). QU-01, QU-04.
- [ ] T2.2 Tests for E7–E13 + invariants (one NEXT, one IN_CONSULT).

## M3: WhatsApp layer + simulator
- [ ] T3.1 `packages/wa`: types (zod) for webhook payloads; message builders with limit validation; `CloudApiClient`; `MockWhatsApp`; template registry.
- [ ] T3.2 `/webhook` GET/POST: signature verification (raw body), dedupe, per-sender ordering (pg-boss singletonKey), status updates → MessageLog.
- [ ] T3.3 Window-aware `Sender` (session vs template). TR-05.
- [ ] T3.4 `/dev/simulate`, `/dev/outbox`, `/dev/clock`; `apps/web/app/dev/simulator` chat UI (patient phone + staff phone panels, buttons and lists rendered, voice and image buttons).
**Verify:** a message typed in the simulator reaches the handler and an echo reply appears.

## M4: Conversation core
- [ ] T4.1 `core/copy`: copy bank EN/HI/Hinglish with variants for all IDs in CONVERSATION_GUIDE §6; `render(id, lang, vars)`; a test that every ID exists in all 3 languages and every button ≤ 20 chars.
- [ ] T4.2 `core/conversation`: state machine reducer (CONVERSATION_GUIDE §4), global intents, resume prompts.
- [ ] T4.3 `core/extract`: schema + **rule-based extractor** (buttons, QR pattern, staff commands, simple times and dates, keywords).
- [ ] T4.4 `core/safety`: emergency keyword matcher (EN/HI/Hinglish + settings extras).
- [ ] T4.5 Consent, number confirmation, alternate number, profiles (ID-01…ID-04).
- [ ] T4.6 Media handling: no download for image/doc/video; `MEDIA_REPORTS`.

## M5: Booking
- [ ] T5.1 SlotService: hold/confirm/release with the `slotKey` constraint; holdSweep job. BK-07, BK-08.
- [ ] T5.2 Smart-suggest offer (form E) + typed-time handling + "See all slots". BK-02.
- [ ] T5.3 List-picker fallback (form C). BK-04.
- [ ] T5.4 Visit type, confirmation, token allocation (slotIndex mode + sequential option). BK-05, BK-06.
- [ ] T5.5 Slot-race path incl. [Try another day] [Call clinic] + contact card. BK-07.
- [ ] T5.6 Booking rules (cut-off, window, closures, profile limit). BK-09.
- [ ] T5.7 Reschedule and cancel (text + buttons). BK-10.
- [ ] T5.8 Scenario tests S1, S2 (without reminders), S6.

## M6: AI understanding
- [ ] T6.1 LLM extractor (`messages.parse` + `zodOutputFormat`, timeout, fallback) per AI_EXTRACTION §4–5.
- [ ] T6.2 Webhook-inline extraction for text so raw text is never enqueued (ARCHITECTURE §3.1).
- [ ] T6.3 STT interface + Sarvam adapter (confirm the API at build time) + mock; voice pipeline in memory; limits.
- [ ] T6.4 `HEALTH_DETAILS_REDIRECT` / `possibleEmergency` handling wired into every state.
- [ ] T6.5 Eval harness `npm run eval:extract` + 120 cases + recorded fixtures for CI.
- [ ] T6.6 Scenario test S5 (with mock STT) + boundary canaries.
**Verify:** eval meets targets on the default model (report saved in `packages/core/extract/eval/reports/`).

## M7: WhatsApp Flow booking form (form D)
- [ ] T7.1 Flow JSON (PICK_DATE_SLOT, CONFIRM) in `packages/wa/flows/booking.json` (pin the current Flow JSON version; check the components).
- [ ] T7.2 `/flow` endpoint: crypto (RSA-OAEP + AES-GCM, inverted IV), ping/INIT/data_exchange, hold at slot_selected, error message on race.
- [ ] T7.3 `nfm_reply` handling → visit type → confirm; 10-min nudge with the list fallback.
- [ ] T7.4 Simulator Flow renderer (dev) using real encryption with a dev key pair.
- [ ] T7.5 Tests: crypto round trip with Meta's sample vectors (if available) or self-generated; E2 → Flow path.

## M8: Queue operations, walk-ins, dashboard board, TV
- [ ] T8.1 QueueService (transactions, versions, audit, SSE): arrive, advance, start, no-show, cancel, move, re-add, undo. QU-02…QU-06.
- [ ] T8.2 Check-in by patient text and by staff; early arrival + auto check-in job. BK-12.
- [ ] T8.3 Walk-in QR: daily code job, `WALKIN` parsing, quota check, token issue. WI-01, WI-02, WI-05.
- [ ] T8.4 Overflow: request, staff WhatsApp + SSE popup, Yes→time/End of queue, No, timeout job, first-wins. WI-03.
- [ ] T8.5 Status replies, TURN_NEAR / NEXT / YOUR_TURN alerts (dedupe). TR-01…TR-03.
- [ ] T8.6 Staff WhatsApp commands (CONVERSATION_GUIDE §8) + broadcasts LATE/PAUSE/RESUME/CLOSE TODAY. DC-01, DC-02, TR-04.
- [ ] T8.7 Dashboard **Queue** tab: 3 columns, primary button logic, secondary actions, overflow popup, counts bar, mobile layout (see PRD QU-02 sketch).
- [ ] T8.8 **TV display** page + voice call-out + QR toggle. TV-01…TV-03.
- [ ] T8.9 Scenario tests S3, S4 + Playwright test of the board (advance moves the line, SSE updates a second browser).

## M9: Jobs and privacy flows
- [ ] T9.1 Reminders (24h, same-day) scheduled at confirm, cancelled on change; reminder button handling. BK-11.
- [ ] T9.2 No-show sweep + end-of-session leftover prompt. BK-13.
- [ ] T9.3 Purge/anonymise job per DATA_POLICY §5 + tests with a fake clock.
- [ ] T9.4 My data / delete my data / stop / start / change number / change language. ID-05.
- [ ] T9.5 Template health job + `system.alert`.
- [ ] T9.6 Scenario S2 complete (with reminder).

## M10: Auth, appointments, settings
- [ ] T10.1 OTP login via the auth template, sessions, roles, rate limits. DB-01.
- [ ] T10.2 **Appointments** tab: list, arrive, cancel, reschedule-on-behalf, staff booking for phone callers, block slots. DB-02, DB-03.
- [ ] T10.3 **Settings** tab: clinic profile, sessions editor, closures with impact confirm + bulk notify, staff, toggles, QR download, display key. CS-01…CS-06.
- [ ] T10.4 `/privacy` page (EN/HI) from DATA_POLICY §7 with the version.

## M11: Hardening and go-live
- [ ] T11.1 Full e2e suite S1–S6 green; boundary suite green; load test (150 patients/day simulated in 10 min; 30 msg/min).
- [ ] T11.2 Security pass: signature checks, authZ on every route, rate limits, headers, dependency audit, secrets only in env.
- [ ] T11.3 `docs/runbooks/breach.md`, `docs/runbooks/operations.md` (restart, restore, rotate keys, template rejected).
- [ ] T11.4 Deployment per DEPLOYMENT.md on the VM; Meta test number end-to-end; then the clinic number.
- [ ] T11.5 Go-live checklist (DEPLOYMENT §7) signed off with the doctor.

---
## Phase 2
- [ ] P2.1 Booking fee toggle: Razorpay payment links, hold during payment, webhook confirm, refunds, policy text. PF-01…PF-03.
- [x] P2.2 Follow-ups: board quick-pick after completion, reminder job, booking prefill. FU-01, FU-02.
- [x] P2.2b Payment reminders: amount due, UPI pay page, repeat reminders, "paid" replies, receipts. PR-01…PR-04.
- [ ] P2.3 Daily summary + Reports tab (aggregates only). RP-01, RP-02.
- [ ] P2.4 Regional language (copy file + templates + extractor eval cases).
- [ ] P2.5 (Optional) Second doctor: doctor selector in booking, per-doctor board.
