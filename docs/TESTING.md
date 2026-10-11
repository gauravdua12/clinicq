# Testing strategy

## 1. Layers
| Layer | Tool | What | Where |
|---|---|---|---|
| Unit (pure) | Vitest | slot engine, queue engine, state machine, copy bank, time parsing, safety matcher, crypto, logger redaction | `packages/*/test` |
| Integration | Vitest + real Postgres (test DB, truncated per test) | services with transactions, constraints, jobs (with a fake clock), webhook route, Flow endpoint | `apps/server/test/integration` |
| Scenario e2e | Vitest + MockWhatsApp + mock extractor/STT | the 6 approved scenarios S1–S6 (CONVERSATION_GUIDE §7) through the real webhook | `apps/server/test/e2e/scenarios` |
| UI e2e | Playwright | queue board, overflow popup, settings, TV display, simulator | `apps/web/e2e` |
| Extraction eval | custom runner | LLM accuracy against `cases.jsonl` (real API, manual) | `packages/core/extract/eval` |
| Boundary | Vitest | data never persisted (§5) | `apps/server/test/boundary` |
| Load | autocannon or k6 (free) | 30 msg/min sustained, 5 dashboards on SSE | `scripts/load` |

## 2. Fixtures and determinism
- Every core function takes `now`. Services read the time from `Clock` (real or fake). `/dev/clock` sets the fake time in e2e.
- Seed: Dr. Sharma clinic, Mon–Sat Morning 10:00–13:00 (20 min) and Evening 17:10–20:00 (20 min), walk-in quota 10, staff "Priya" (STAFF) and the doctor (DOCTOR). This matches the QUEUE_ENGINE worked examples and the mockups.
- The mock extractor is a lookup from text to an Extraction fixture (recorded from the eval run), with the rule-based extractor as fallback.

## 3. Must-have cases (beyond worked examples)
- Concurrency: 20 parallel holds on the same slot → exactly 1 success. Parallel `advance()` calls → invariants hold (partial unique indexes).
- Reschedule frees the old slot; cancel frees the slot; a NO_SHOW frees the slot key.
- 24-hour window: send outside the window uses the template; missing template mapping → skipped + logged.
- Webhook: bad signature → 401; duplicate wamid → processed once; out-of-order delivery for the same sender stays ordered.
- Flow crypto round trip; decrypt failure → 421; race at slot_selected → error_message screen.
- Overflow: two staff respond → first wins; timeout fires → patient gets the offer; late staff reply → "already handled".
- Copy: every ID in EN/HI/Hinglish; button titles ≤ 20; list rows ≤ 24; no unresolved `{{var}}`.
- Retention purge with a fake clock at +91 days, +181 days, +13 months.
- Erasure: after "delete my data", the account and profiles are gone, future appointments are cancelled, past visits are anonymised.

## 4. Scenario tests S1–S6
Implement each script in CONVERSATION_GUIDE §7 as a test that sends inbound events in order and asserts the **outbound copy IDs and buttons** (not exact strings, since variants rotate), plus DB state. Run in all 3 languages for S1 (copy completeness).

## 5. Data-boundary suite (`npm run test:boundary`): must always pass
1. **Canary strings:** `CANARY_SYMPTOM_7f3a "bukhar teen din se sugar 300"`, `CANARY_MED_91bc "paracetamol 650"`, `CANARY_EMERG_c2d4 "chest pain"`.
2. Send them as: plain text in IDLE, text during each booking state, a voice note (mock STT returns the canary), an image caption, a Flow reply (as an injected field), and a staff command argument.
3. After the run, assert that none of the canary tokens appear in:
   - any table, via a full-text scan of every text/json column in the public schema, **including the `pgboss` schema** (job data, archive);
   - captured log output (pino destination stream);
   - MockWhatsApp outbound messages (the bot must not echo symptoms back);
   - any file written under the project or tmp dir during the test (fs spy: no writes outside allowed paths).
4. Assert that the media download function was **never** called for image/document types, and was called exactly once (in memory) for audio.
5. The schema guard (DATA_POLICY §4.5) runs here too.

## 6. Manual checks before go-live
- Real phone test on Android + iPhone (old and new WhatsApp versions) for buttons, lists, the Flow, and the Flow fallback.
- Hindi and Hinglish read-through by a native speaker (tone: warm, respectful).
- TV readability at 5 m; voice call-out pronunciation of tokens ("W saat").

## Latest results
See [TEST_REPORT.md](TEST_REPORT.md) for the full run: automated, UI, UAT, load, live-AI load and break-point tests.
Playwright writes only to `test-results/ui/`, because it empties its output folder on every run. UAT and load reports live in `test-results/uat/` and `test-results/load/` (git-ignored).
