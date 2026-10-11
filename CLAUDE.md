# CLAUDE.md: ClinicQ (WhatsApp clinic assistant)

ClinicQ is a WhatsApp assistant for one doctor's clinic (solo, or with a small staff). It handles appointment booking, walk-ins, a single daily token queue and live tracking.
It stores **logistics only, never medical data.** The approved spec lives in `docs/`. Read the relevant doc before you change a module.

## Read first
| Working on | Read |
|---|---|
| Anything | `docs/PRD.md`, `docs/DATA_POLICY.md` |
| Bot replies, intents, copy | `docs/CONVERSATION_GUIDE.md` |
| Slots, tokens, queue, ETA | `docs/QUEUE_ENGINE.md` |
| WhatsApp API, templates, Flows | `docs/WHATSAPP_INTEGRATION.md` |
| Free-text and voice understanding | `docs/AI_EXTRACTION.md` |
| DB | `docs/SCHEMA.md` |
| HTTP endpoints, SSE | `docs/API.md` |
| Build order | `docs/TASKS.md` (work milestone by milestone and tick items off) |
| Tests | `docs/TESTING.md` |

## HARD RULES: data boundary (never violate; a test suite enforces these)
1. **Never persist raw inbound message text.** Not in the DB, logs, job payloads, error trackers or analytics. Persist only the structured fields that `packages/core/extract` returns (intent, date, time, profile ref, name, phone, language).
2. **Never persist voice-note audio or transcripts.** Download the audio into memory (a Buffer, never disk), send it to speech-to-text, run extraction, then drop the references. No temp files.
3. **Never download image, document, video or sticker media.** Log only `media_received: <type>` and reply with the "bring reports to clinic" copy.
4. **Never add free-text "reason", "symptoms", "notes" or "complaint" fields** to any patient-facing input, DB model or dashboard form. Visit type is the enum `NEW | FOLLOW_UP | REPORT_SHOW`.
5. **The LLM never writes patient-facing replies.** Replies come only from the copy bank (`packages/core/copy`). The LLM is used only for structured extraction (JSON schema).
6. **Logging:** use the shared logger (`packages/core/log`), which redacts `text`, `body`, `caption`, `transcript` and phone fields. Never `console.log` request bodies.
7. **Phone numbers** are stored encrypted (AES-256-GCM) with an HMAC hash for lookup. Show them masked (`+91 98xxx x3210`) everywhere except the patient's own number-confirmation message.
8. **Emergency keyword detection** runs in memory only. Nothing about it is stored except the counter `emergency_reply_sent`.
9. **No marketing messages.** Only the utility and authentication template categories (NMC rules plus WhatsApp policy).

## Stack (no Docker, no Redis, no paid licenses)
- **Node.js 24 LTS, TypeScript (strict), npm workspaces** (no extra package manager to install).
- `apps/server`: **Fastify**. WhatsApp webhook (processed in memory, per sender in order), Flow data endpoint, REST API, SSE. It also serves the statically exported dashboard. **One process.**
- `apps/web`: **Next.js** (static export, `output: 'export'`). Staff dashboard (queue board, appointments, settings), TV display page, dev WhatsApp simulator.
- `packages/core`: pure domain logic with no I/O: slot engine, queue engine, conversation state machine, copy bank, date parsing helpers, extractor interface.
- `packages/db`: Prisma schema and client (PostgreSQL 16+).
- `packages/ai`: model adapters (`bedrock-mantle:`, `bedrock:`, `anthropic-bedrock:`, `openai-compat:`, `anthropic:`), speech-to-text (Voxtral, Transcribe, Sarvam, Whisper), and the bake-off harness (`eval/`).
- `packages/wa`: WhatsApp Cloud API client (send, templates, media URL fetch, Flow crypto) plus `MockWhatsApp` for dev and tests.
- **Jobs:** a Postgres-backed scheduler (`apps/server/src/jobs/scheduler.ts`, table `ScheduledJob`) in the same process. Payloads hold IDs only.
- **AI (model-agnostic):** the `LlmProvider` interface, with adapters `bedrock:` (AWS Converse: gpt-oss, Qwen, Llama, Nova…), `anthropic-bedrock:` (Claude on Bedrock via `@anthropic-ai/bedrock-sdk`), `openai-compat:` (self-hosted open-source via vLLM or Ollama), `anthropic:`, and `rules`. Default (bake-off winner, docs/MODEL_SELECTION.md): primary `bedrock-mantle:qwen.qwen3-32b`, with failover to `bedrock-mantle:mistral.mistral-large-3-675b-instruct`. The admin can switch at runtime. zod validates every model's output.
- **Speech-to-text:** the `SpeechToText` interface, with adapters `voxtral-small` (default), `voxtral-mini`, `transcribe`, `sarvam`, `openai-compat` (self-hosted Whisper), and `mock`.
- **Cloud:** AWS `ap-south-1` (Mumbai). EC2 with an IAM role, and Postgres on the instance. Backups go to S3.
- **Tests:** Vitest. Playwright for dashboard end-to-end.
- **Time:** store UTC. All clinic logic in `Asia/Kolkata` (via `CLINIC_TZ`). Use `date-fns-tz` or Temporal polyfill. Never use the server's local time.

## Commands (to be created in Milestone 0)
```bash
npm install
npm run db:migrate     # prisma migrate dev
npm run db:seed        # demo clinic: Dr. Sharma, sessions, staff
npm run dev            # server + web in watch mode; WA_MODE=mock by default
npm test               # vitest (all packages)
npm run test:boundary  # data-boundary suite (must always pass)
npm run test:e2e       # simulator scenarios + Playwright
npm run build && npm start
```

## Conventions
- Domain logic goes in `packages/core` as pure functions that take `now` and data as arguments. That makes it deterministic and testable. No `Date.now()` inside core.
- Every state change to an Appointment or QueueEntry goes through one service function, which writes an `AuditLog` row and emits an SSE event.
- DB writes that allocate a slot or token use a transaction. Slot uniqueness is enforced by the `Appointment.slotKey` unique column (see `docs/SCHEMA.md`). Never check-then-insert without the constraint.
- Webhook handler: verify the signature → dedupe on `wamid` → enqueue the job → return 200 within 1s. Heavy work happens in jobs.
- WhatsApp UI limits: reply buttons ≤ 3 with titles ≤ 20 chars; list rows ≤ 10 with titles ≤ 24 chars. `packages/wa` validates these at build time of each message.
- Copy lives in `packages/core/copy/{en,hi,hinglish}.ts`, keyed by message ID (see `docs/CONVERSATION_GUIDE.md`). Never inline strings in handlers.
- Config only via env (validated with zod at boot). See `docs/ARCHITECTURE.md#configuration`.
- Commit per completed task in `docs/TASKS.md`. Each commit keeps `npm test` and `npm run test:boundary` green.

## Before changing the prompt or a model
Run `npm run eval:extract -- --set both --models <spec>` (or `--cascade "a>b"`). Compare against docs/MODEL_SELECTION.md. Never tune on `holdout.ts`.
