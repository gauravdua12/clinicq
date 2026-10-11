# ClinicQ: development template

A WhatsApp-first appointment, walk-in and token-queue assistant for a doctor's clinic in India. One doctor, with a small staff or solo.
This folder holds the approved specification **and the built MVP**.

## Run it (local)
```bash
brew services start postgresql@16          # once: createuser -s clinicq && createdb -O clinicq clinicq && createdb -O clinicq clinicq_test
npm install && npm run db:migrate && npm run db:seed
npm run dev                                # http://localhost:8080 → Login → "Dev: Doctor" · /dev/simulator · /display?key=dev
npm test                                   # 57 tests: unit, scenarios S1–S6, data boundary, integration
```
To use the real AI locally (AWS credentials on this Mac), set the variables in `.env` as below. Model choice and results are in [docs/MODEL_SELECTION.md](docs/MODEL_SELECTION.md).
```
EXTRACTOR_PRIMARY=bedrock-mantle:qwen.qwen3-32b
EXTRACTOR_ESCALATION=bedrock-mantle:mistral.mistral-large-3-675b-instruct
STT_PROVIDER=voxtral-small
STT_FALLBACK=voxtral-mini
```

## How to use this with Claude Code
1. Open this folder in Claude Code. `CLAUDE.md` loads automatically.
2. Say: *"Start Milestone 0 from docs/TASKS.md."* Then continue milestone by milestone.
3. After each milestone, run the verification listed in `docs/TASKS.md`. Test the chats on the built-in WhatsApp simulator before connecting a real number.

## Document index
| Doc | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Rules for Claude Code: stack, commands, **hard data-boundary rules** |
| [docs/PRD.md](docs/PRD.md) | Product requirements: user stories plus acceptance criteria |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, repo layout, sequence diagrams, configuration |
| [docs/DATA_POLICY.md](docs/DATA_POLICY.md) | What is and isn't stored, retention, privacy notice draft, patient rights |
| [docs/CONVERSATION_GUIDE.md](docs/CONVERSATION_GUIDE.md) | Tone, intents, state machine, copy bank, the 6 approved scenarios, staff and doctor commands |
| [docs/QUEUE_ENGINE.md](docs/QUEUE_ENGINE.md) | Slot engine, smart-suggest rules, token queue states, next-patient rules, ETA, worked examples |
| [docs/WHATSAPP_INTEGRATION.md](docs/WHATSAPP_INTEGRATION.md) | Meta setup checklist, webhook, message types, templates (EN/HI), Flow booking form |
| [docs/AI_EXTRACTION.md](docs/AI_EXTRACTION.md) | Speech-to-text plus LLM structured extraction, schema, prompt, eval set |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Prisma schema draft |
| [docs/API.md](docs/API.md) | REST endpoints and SSE events |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | VM + systemd + Caddy + Postgres + backups (no Docker) |
| [docs/TASKS.md](docs/TASKS.md) | Milestone-ordered build tickets with a definition of done |
| [docs/MODEL_SELECTION.md](docs/MODEL_SELECTION.md) | Model bake-off results and the chosen setup |
| [docs/runbooks/aws-bedrock-access.md](docs/runbooks/aws-bedrock-access.md) | Unblocking the AWS account (Free plan, quotas) |
| [docs/TESTING.md](docs/TESTING.md) | Unit, integration, simulator end-to-end, data-boundary tests |
| [docs/mockups/](docs/mockups/) | Approved chat mockups (slot display and sample conversations) |

## Key approved decisions
- India; Meta WhatsApp Cloud API direct; English + Hindi + Hinglish (mirror the patient).
- Natural conversation (text and voice). Buttons are optional shortcuts.
- **Slot display:** smart-suggest the 2 nearest slots if free near the requested time. Otherwise a WhatsApp Flow booking form. A list picker is the fallback.
- Queue board: **Waiting → Next → In consultation → (Consultation completed removes the patient)**, plus No-show and Cancelled.
- Walk-in quota full → ask staff ("Can you adjust?" Yes plus a time, or No → offer booking slots).
- One booking per slot, always (even for family members on the same phone).
- Booking fee: optional toggle (off by default).
- TypeScript, Fastify, Next.js (static), PostgreSQL, pg-boss. **No Docker, no Redis.**

> Legal note: this design minimises regulatory exposure but is not legal advice. Have a lawyer review the privacy notice (`docs/DATA_POLICY.md`) before go-live.
