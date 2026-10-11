# ClinicQ test report (10 Oct 2026)

Build under test: local MacBook (Apple Silicon), Postgres 16, Node 24, bundled server `apps/server/dist/main.js`.
Live AI: Bedrock Mumbai (Mantle). **Qwen3 32B** primary, failing over to **Mistral Large 3**. **Voxtral Small** for voice notes.
Test clock: Fri 9 Oct 2026 (so "kal" = Sat 10 Oct).

## Summary

| Layer | What | Result |
|---|---|---|
| Type safety | `npm run typecheck` (all packages) | ✅ clean |
| Unit | queue engine, slot engine, extractor rules and guards, crypto, WhatsApp payloads, Flow crypto, templates, scheduler resilience | ✅ 63/63 |
| Integration | API, auth, settings, closures, walk-in overflow, Demo Studio, base path | ✅ 17/17 |
| End to end | the 6 approved conversation scenarios (S1–S6) on the simulator | ✅ 7/7 |
| Data boundary | symptoms, voice notes, images and PDFs are sent, then **the whole DB and log are scanned**: no medical text or transcripts stored | ✅ 7/7 |
| UI (Playwright, real Chrome) | desk board, appointments, settings, TV display, simulator, Demo Studio; desktop + phone | ✅ 11/11 |
| AI model eval | 14 Bedrock models × 210 cases (140 dev + 70 held-out) | chosen cascade: **94.3% held-out, 100% health and emergency recall**. See MODEL_SELECTION.md |
| **User-level (UAT)** | 25 patient personas, **live models**, including your real WhatsApp voice note | ✅ **25/25** |
| **Load** | 10 scenarios, up to 400 concurrent patients, 300 live dashboards | ✅ 0 errors, no double booking |
| **Live-AI load** | up to 150 concurrent free-text messages through Bedrock | ✅ 0 errors, p95 2.8 s |
| **Break-point tests** | DB outage, AI outage, restart mid-chat, duplicate delivery, abuse input | ✅ after fixes (below) |

## User-level testing (live AI)
Each persona talks to the real conversation engine the way a patient would: it types, taps buttons by their label, or sends a voice note. Each run checks the final booking in the database, the language of the replies, and that no health data was saved.

| # | Persona | Result |
|---|---|---|
| u01 | Hinglish, for mother, "kal shaam" | ✅ booked Sat evening |
| u02 | English, exact time next Tuesday 11 am | ✅ booked Tue 11:00 |
| u03 | Hindi (Devanagari), Monday evening 6 | ✅ nearest free slot offered and booked |
| u04 | **Real WhatsApp voice note** (Hindi): for mother, tomorrow 10–11 | ✅ transcribed by Voxtral, booked Sat 10:00, Devanagari name kept |
| u05 | Family: self at 6:30, then son at the same slot | ✅ son offered and booked the next slot (one booking per slot) |
| u06 | Reschedule in plain words | ✅ |
| u07 | Cancel in Hinglish | ✅ |
| u08 | Symptoms while booking | ✅ polite redirect, nothing stored, booking continued |
| u09 | Emergency | ✅ 108 + clinic number at once |
| u10 | Clinic info in Hinglish (fees, address, timings) | ✅ |
| u11 | Asks for a human | ✅ call-clinic option |
| u12 | Privacy: show my data, then delete it | ✅ |
| u13 | Typos and shorthand ("tmrw 6pm pls") | ✅ |
| u14 | Changes mind mid-flow | ✅ |
| u15 | Different contact number | ✅ |
| u16 | Asks for Sunday (closed) | ✅ next open day offered |
| u17 | Too far ahead | ✅ booking window explained |
| u18 | Emoji-only message | ✅ menu |
| u19 | "Cancel tomorrow and book Monday" in one message | ✅ confirms the cancellation first (one action at a time) |
| u20 | "I've reached" for today's booking | ✅ joins the queue as Waiting |
| u21 | Walk-in via the reception QR, Hindi name | ✅ token issued |
| u22 | Status after walk-in | ✅ position and ETA |
| u23 | Very long rambling message | ✅ |
| u24 | Prompt injection asking for medical advice | ✅ refused politely, no advice |
| u25 | Says thanks after booking | ✅ |

Typical reply time is 0.5–1.8 s for text and about 4.6 s for a voice note. Full transcripts are generated locally in `test-results/uat/transcripts.md`. They are not committed because the voice note contains a personal name.

## Load testing (rules extractor, so it measures the server, not the AI provider)
| Scenario | OK | p50 ms | p95 ms | req/s |
|---|---|---|---|---|
| L1 first message × 400, concurrency 10 | 400/400 | 13 | 22 | 642 |
| L1 first message × 400, concurrency 50 | 400/400 | 62 | 83 | 779 |
| L1 first message × 400, concurrency 100 | 400/400 | 137 | 195 | 645 |
| L1 first message × 400, concurrency 200 | 400/400 | 254 | 299 | 743 |
| L2 **booking storm**: 200 patients ask for the *same* slot at once | 200/200 | 422 | 425 | 464 |
| L2 storm: all 200 tap the visit type | 200/200 | 371 | 373 | 526 |
| L3 walk-in rush: 150 walk-ins in one burst | 150/150 | 149 | 151 | 968 |
| L4 dashboard reads × 2,000 | 2000/2000 | 27 | 30 | 1,828 |
| L4 "Consultation completed" × 60 while dashboards poll | 60/60 | 16 | 17 | 608 |
| L6 rapid-fire: 60 messages from one number | 60/60 | 18 | 76 | 743 |

- **Booking integrity:** exactly **1** booking at the contested 6:10 PM slot. Everyone else was told it was taken and offered the nearest free slots.
- **Live screens:** 300 dashboard and TV connections open together; **300/300** received the update.
- **Abuse input:** malformed JSON gave 400, bad signature 401, a 2 MB body was rejected (connection closed, as the 1 MB limit intends), and 20k-character text, SQL-like text and control/RTL characters all got 200 with no effect.
- Health after the run: `{"ok":true,"db":true}`, 0 error log lines, memory steady at about 370 MB.

**Capacity view:** a busy single-doctor clinic sees well under 1 message per second. The server sustained about 650–1,000 messages per second, so it has more than 500× headroom.

## Live-AI load (real Bedrock calls)
| Messages | Concurrency | OK | p50 | p95 | p99 | Throughput |
|---|---|---|---|---|---|---|
| 120 | 10 | 120/120 | 0.40 s | 1.02 s | 1.29 s | 16 msg/s |
| 120 | 30 | 120/120 | 0.42 s | 1.06 s | 1.30 s | 42 msg/s |
| 120 | 60 | 120/120 | 0.70 s | 1.38 s | 1.69 s | 52 msg/s |
| 300 | 150 | 300/300 | 1.06 s | 2.79 s | 3.42 s | 83 msg/s |

Across all 840 model calls: **0 failed calls**, and 5.8% escalated to Mistral Large 3 (as designed: low confidence, disagreement with the rules, or a high-impact intent). The AWS account limits did not throttle at 150 concurrent messages.

## Break-point testing: what broke and what was fixed
| # | How we tried to break it | What happened | Fix | Re-test |
|---|---|---|---|---|
| 1 | **Database stopped** while patients were chatting | **Server process crashed.** A failed job poll became an unhandled promise rejection | The scheduler catches and logs `job_poll_failed` and keeps polling. A process-level safety net was added. The webhook returns 500 while the DB is down so Meta retries | ✅ server stays up, `/healthz` shows `db:false`; DB back → Meta's retry of the *same* message processed once, booking confirmed, health back to ok. Regression test `scheduler.test.ts` fails on the old code |
| 2 | **Both AI models unavailable** (bogus model IDs) | Booking kept working through the rules fallback, but **silently** | A warning log line `ai_models_unavailable` for alerting | ✅ Hinglish booking still completes; warning logged |
| 3 | Server killed mid-conversation and restarted | Conversation continued from the same step | (none needed) | ✅ |
| 4 | Two "Consultation completed" taps at once (double-tap) | Could skip a patient | Per-doctor queue lock + "expected current patient" guard (stale tap → 409) | ✅ L4 + UI test |
| 5 | 200 patients race for one slot | — | DB unique constraint + 5-minute hold | ✅ exactly 1 booking |
| 6 | Malformed JSON to the webhook | 500 | 400 | ✅ |
| 7 | Same WhatsApp message delivered twice | — | De-duplicated on message ID | ✅ |
| 8 | Database reseeded under a running server | Login 404, board stuck on "Loading" | Clinic cache revalidates; board shows an error with Retry | ✅ |
| 9 | Walk-in joins when the queue is empty | "You're next" arrived **before** "You've joined" | Message order fixed | ✅ |
| 10 | Patients waiting but "Next" empty | Staff had to promote manually | Auto-promote the top Waiting patient | ✅ |
| 11 | Devanagari names | Vowel signs (matras) stripped ("दरशन") | Unicode mark class kept | ✅ |
| 12 | "between 10 and 11" / no time mentioned | Model treated a range as exact, or invented a time | Deterministic guards: range → "around", no time evidence → no time | ✅ UAT u04, u13 |
| 13 | Test tooling: UI test run deleted the UAT and load reports | Playwright empties its output folder | Playwright now writes to `test-results/ui/` only | ✅ |
| 14 | One number flooding the server | — | Per-number rate limit: extra messages are acknowledged to Meta and dropped (logged `rate_limited`) | ✅ L6 |

## Live server tests (11 Oct 2026, incolo-prod, https://q.incolo.si)
Run on the production server against the real database, live Bedrock models (called from the server's IAM role) and the real Meta Cloud API. The repeatable part is `scripts/ops/live-check.ts` (15 checks); the infrastructure tests were run by hand.

| Test | Result |
|---|---|
| Post-deploy check: webhook verify (right/wrong token), unsigned webhook refused, dev tools and simulator page off, live-AI booking (Hinglish, "for mother, named Sunita"), exact slot booked, name stored encrypted, no raw text in the DB, duplicate delivery processed once, 2-hour-old re-delivery not acted on, erasure via WhatsApp, booking released | ✅ 15/15 (repeated after every deploy) |
| 10 patients at once through the live AI, each asking for a different slot | ✅ 10 × 15/15; app peak memory 183 MB, 1.3 GB still free; no errors; nothing left behind |
| Database stopped mid-traffic | ✅ webhook 500 (Meta retries), app stays up; retried message processed exactly once after the DB returns |
| Planned restart / app crash (kill -9) / HTTPS front-end crash | ✅ back in 3.1 s / 6.4 s / ~3 s |
| Both AI models unavailable | ✅ booking still completes (rules fallback); `ai_models_unavailable` logged |
| Switch ClinicQ → watsappai → ClinicQ (`demo-switch`) | ✅ 18 s / 8 s; each side verified from the internet |
| Switch when ClinicQ can't start (real event: HTTPS front end misconfigured) | ✅ rolled back: watsappai restored automatically in 17 s |
| Server reboot while ClinicQ is live | ✅ ClinicQ back in ~23 s, watsappai stays stopped, 15/15 after reboot |
| From the internet | ✅ Let's Encrypt certificate (auto-renews), HTTP→HTTPS 308, HSTS/nosniff/no-referrer headers, API 401 without login |

**Found and fixed on the live server:** staff OTP template missing its copy-code button parameter (Meta would reject every login code) · build fetched Google Fonts (now bundled) · settings folder not readable by the service user · Caddy log file created as root (the first switch rolled back correctly because of it) · the installer could execute a half-updated copy of itself during `update` · migration needed the database started while watsappai is live · erasure left a conversation-state row when the final WhatsApp confirmation couldn't be delivered (regression test added) · dev simulator page visible in production · 6 templates refused by Meta (too many variables per word / wrong category), now rewritten and pending.

## Not covered yet (needs real accounts)
- A conversation from a real phone (9920323832 → Meta test number). Everything up to Meta is verified live; the last step needs a person to send a message.
- WhatsApp Flows (slot-grid form): created and validated by Meta, but publishing needs business verification. Until then the bot uses the list picker (covered end to end).
- Lawyer review of the privacy notice (planned at customer onboarding).

## Reproduce
```bash
npm run typecheck && npm test                        # unit, integration, e2e, boundary (94)
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npx playwright test   # UI (11)
npx tsx scripts/uat/run.ts                           # UAT, live AI (needs AWS creds in .env)
node scripts/build-server.mjs                        # then start dist/main.js on :8097 against clinicq_load
npx tsx scripts/load/run.ts                          # load + abuse
npx tsx scripts/load/live.ts --n 300 --c 150         # live-AI load (server on :8098 with live .env)
```
