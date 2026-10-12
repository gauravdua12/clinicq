# Language understanding: speech-to-text and structured extraction

## 1. Principles
- The LLM is a **parser, not a chatbot.** It turns a patient message into a fixed JSON object. It **never** writes replies, so it can't give medical advice. This also keeps us within Meta's 2026 rule against general-purpose AI assistants.
- **In memory only.** Text, audio and transcripts are never persisted or logged (DATA_POLICY §3). Log only `{intent, latencyMs, model, ok}`.
- **Minimal context to the model provider:** send the message text, today's date and weekday in IST, the clinic session names and times, and the patient's profiles as **opaque labels** (`P1: self`, `P2: relation=MOTHER`, `P3: relation=SON`). **Never send phone numbers or stored names.** Exception: a name the patient types in this very message is necessarily part of the text.
- **Deterministic first:** button and list IDs, the QR walk-in pattern, staff commands and the emergency keyword matcher are handled by rules, before and without the LLM.
- **Graceful fallback:** if the LLM times out (`EXTRACTOR_TIMEOUT_MS`, default 4000) or errors, use the rule-based extractor (regex for times and dates, keyword intents). If that's inconclusive, send menu buttons (`EXTRACTOR_DOWN`).

## 2. Pipeline
```
inbound ─▶ [rules] button/list id? → event
        ─▶ [rules] WALKIN code? staff command? → event
        ─▶ [safety] emergency keywords → EMERGENCY_REPLY first (continue processing)
        ─▶ voice? → download to Buffer → STT.transcribe(buffer, hint=lang) → transcript (memory)
        ─▶ LLM extract(text|transcript, context) → Extraction (zod-validated)
        ─▶ post-validate (date in window? time inside sessions? phone 10 digits?) → event
        ─▶ drop text/transcript/buffer references
```

## 3. Extraction schema (zod, `packages/core/extract/schema.ts`)
```ts
import { z } from "zod";

export const Extraction = z.object({
  intent: z.enum([
    "GREETING","BOOK","RESCHEDULE","CANCEL","STATUS","ARRIVED","MY_APPOINTMENTS",
    "CLINIC_INFO","TALK_TO_STAFF","MY_DATA","DELETE_DATA","STOP","START",
    "CHANGE_NUMBER","CHANGE_LANGUAGE","PROVIDE","AFFIRM","DENY","THANKS","WAIT","RUDE","HELP","OTHER",
  ]),
  date: z.string().nullable(),            // "YYYY-MM-DD", resolved from relative words using context.today
  time: z.string().nullable(),            // "HH:MM" 24h
  timeQualifier: z.enum(["exact","around","after","before"]).nullable(),
  partOfDay: z.enum(["morning","afternoon","evening","night"]).nullable(),
  forWhom: z.enum(["self","existing_profile","new_person","unknown"]),
  profileRef: z.string().nullable(),      // e.g. "P2" (only from provided labels)
  newPersonName: z.string().nullable(),   // only if the patient typed a name for a new person
  relation: z.enum(["SELF","MOTHER","FATHER","SPOUSE","SON","DAUGHTER","SIBLING","GRANDPARENT","OTHER"]).nullable(),
  selfName: z.string().nullable(),        // patient's own name if stated ("my name is Anil")
  phone: z.string().nullable(),           // 10-digit Indian mobile if stated
  visitType: z.enum(["NEW","FOLLOW_UP","REPORT_SHOW"]).nullable(),
  clinicInfoTopic: z.enum(["timings","address","fees","other"]).nullable(),
  language: z.enum(["en","hi","hinglish"]),
  hasNonBookingContent: z.boolean(),      // symptoms, health details, medical questions, reports
  possibleEmergency: z.boolean(),         // second safety net besides the keyword matcher
  confidence: z.number(),                 // 0..1 self-reported; < 0.7 triggers escalation
});
export type Extraction = z.infer<typeof Extraction>;
```
Post-validation clamps invalid values to `null` (e.g., `date` in the past or beyond the window → keep it, and let the booking rules reply `BOOKING_RULE_BLOCKED`; malformed → null). `newPersonName` and `selfName` are trimmed, title-cased and capped at 60 chars, and may only contain letters, spaces and `.`, since they will be stored as a profile name.

## 4. Model providers (model-agnostic; AWS-first)
The extractor depends only on the `LlmProvider` interface (`packages/core/extract/provider.ts`):
```ts
interface LlmProvider { name: string; extractJson(system: string, user: string, schema: JsonSchema, opts: {timeoutMs: number}): Promise<unknown> }
```
Every adapter returns raw JSON. **zod validation happens once, in the shared `extract()`**, so all models are held to the same contract.

| Adapter (`EXTRACTOR_*` value prefix) | Use | Notes |
|---|---|---|
| `bedrock:` (AWS SDK `ConverseCommand`) | **Open-weight and Amazon models on Bedrock**: `openai.gpt-oss-120b-1:0`, `openai.gpt-oss-20b-1:0`, Qwen3, Llama, Mistral, Nova | Structured output through Converse tool use: one tool `record_extraction` with the JSON schema, selected via `toolChoice` |
| `anthropic-bedrock:` (`@anthropic-ai/bedrock-sdk`) | Claude on Bedrock, e.g. the India geo profile `in.anthropic.claude-haiku-4-5-20251001-v1:0` | Uses the official Anthropic SDK and a strict tool for structured output |
| `openai-compat:` (HTTP `/v1/chat/completions`) | **Self-hosted open-source models** (vLLM, Ollama, llama.cpp server, TGI) | `response_format: {type: "json_schema"}`. Base URL from `OPENAI_COMPAT_BASE_URL` |
| `anthropic:` (`@anthropic-ai/sdk`) | Anthropic API direct (optional) | `messages.parse` + `zodOutputFormat` |
| `rules` | Built-in fallback, no model | regex and keyword based |

### 4.1 Default on AWS: a quality-guarded cascade ("don't compromise customer handling")
Chosen by the bake-off in **docs/MODEL_SELECTION.md** (14 Mumbai models, 210 cases, held-out set):
```
EXTRACTOR_PRIMARY=bedrock-mantle:qwen.qwen3-32b                              # open-weight, Mumbai, p50 ~360 ms
EXTRACTOR_ESCALATION=bedrock-mantle:mistral.mistral-large-3-675b-instruct    # open-weight, Mumbai, strongest tested
STT_PROVIDER=voxtral-small   STT_FALLBACK=voxtral-mini
AWS_REGION=ap-south-1
```
The admin can change these at runtime (Settings → Language model). `bedrock-mantle:` is the Bedrock OpenAI-compatible endpoint (`bedrock-mantle.<region>.api.aws`, SigV4).
1. Call **primary** (timeout 3.5 s).
2. **Escalate** to the escalation model when any of these hold:
   - the primary errors, times out, or returns JSON that fails the schema;
   - `confidence < 0.7` (the model self-reports confidence in the schema);
   - `intent = OTHER` on a message of 3+ words;
   - a booking intent with an unparseable date or time phrase detected by rules (e.g., the text has a digit or a time word, but the model returned `time=null`);
   - a language mismatch with the rules (Devanagari present but the model returned `en`);
   - the model's date (or exact time) disagrees with the deterministic rules;
   - the rules see a high-impact intent (cancel, reschedule, stop, delete data, arrived) and the model doesn't.
3. **Safety merge:** `hasNonBookingContent` and `possibleEmergency` are OR-ed across the rules, the primary and the escalation (when called). For safety flags, the system leans towards caution.
4. If both models fail, use the **rules** extractor, and if that's inconclusive, fall back to menu buttons. A patient never gets a dead end.
5. Log only `{provider, model, escalated, reason, latencyMs, ok}`. This lets the escalation rate be monitored. Target: under 15%.

**Why this pairing:** on Bedrock Mumbai, gpt-oss-120b costs about $0.18 / $0.71 per M tokens (input/output), against about $1 / $5 for Claude Haiku 4.5 (check current prices at go-live). With roughly 10% escalation, the cost is **about ₹0.05–0.07 per free-text message**. The eval (§7) decides the final pairing. Rerun it with `npm run eval:extract -- --provider <spec>` for any candidate (gpt-oss-20b, Qwen3, Nova Lite, a self-hosted Llama or Qwen through `openai-compat:`). Pick the cheapest primary that meets the targets *after* escalation, and record the result in `eval/reports/`.

**Open-source option:** the same code runs fully on open-source models. Point `EXTRACTOR_PRIMARY` (and optionally the escalation) at `openai-compat:` with a self-hosted model (e.g., Qwen3-32B or gpt-oss-120b on vLLM). No code change is needed.

### 4.2 Implementation notes
- `renderUserTurn` builds: `Today: Fri 2026-10-10 (Asia/Kolkata), now 12:05.
Sessions: Mon–Sat Morning 10:00–13:00, Evening 17:00–20:00; Sunday closed.
Profiles: P1 self; P2 relation=MOTHER.
Conversation state: BK_WHEN (bot asked: day and time).
Message: """<text>"""`
- **Conversation state hint:** pass the current state and the question the bot asked (as a copy ID description, never a previous message text), so short replies like "6:30" or "haan" resolve correctly.
- Keep the system prompt byte-stable, with no dates in it. The volatile context goes in the user turn (cache-friendly for providers that support prompt caching).
- AWS auth: an IAM instance role on EC2 (no keys on disk). Permissions: `bedrock:InvokeModel` on the two model or profile ARNs, and `transcribe:StartStreamTranscription`.
- Data handling: Bedrock doesn't store or log prompts or completions by default, and doesn't use them for training. **Disable Bedrock model-invocation logging** (it is off by default), so patient text is never written to CloudWatch or S3.

## 5. System prompt (`packages/core/extract/prompt.ts`), initial version
```
You convert WhatsApp messages sent to a doctor's clinic appointment assistant into JSON.
You never reply to the patient. Output only the JSON object defined by the schema.

Messages may be in English, Hindi (Devanagari) or Hinglish (Hindi in Roman script), and may be
transcribed voice notes with errors. Set "language" to the language the patient wrote in.

Rules:
- Resolve relative dates using "Today" from the context: aaj/today = today; kal/tomorrow = today+1
  (if the message clearly refers to the past, e.g. "kal aaya tha", it is not a booking date);
  parso/day after tomorrow = today+2; weekday names = the next such day (today if it is that day
  and the time is still ahead); "next Monday" = the Monday of next week if today is Mon–Sun before it.
- Times: "6 baje", "6 pm", "shaam 6" → 18:00; "subah 10" → 10:00; "dopahar 2" → 14:00. If a bare
  hour like "6" is ambiguous, choose the one that falls inside a clinic session. "ke aas paas",
  "around", "approx" → timeQualifier "around"; "ke baad", "after" → "after"; "se pehle", "before" → "before".
- partOfDay: subah/morning, dopahar/afternoon, shaam/evening, raat/night.
- forWhom: "me/mera/mujhe" → self. A relation word matching a provided profile label → existing_profile
  with that profileRef. A new name or relation not in the labels → new_person (fill newPersonName/relation).
- visitType: "follow up", "dobara dikhana", "review" → FOLLOW_UP; "report dikhani hai", "show reports" → REPORT_SHOW;
  "first time", "new" → NEW; otherwise null.
- hasNonBookingContent = true if the message contains ANY symptoms, illness, medicines, test results,
  body parts with complaints, or medical questions. Do NOT copy those details into any field.
- possibleEmergency = true for chest pain, breathing difficulty, unconsciousness, heavy bleeding, seizures,
  poisoning, accident injuries, suicidal intent, stroke signs, or similar urgent danger.
- Short answers: interpret them in light of "Conversation state" (e.g. "6:30" while choosing a slot → PROVIDE with time).
- If unsure, use null rather than guessing. Never invent names or phone numbers.
```
Add ~15 few-shot examples (from §7) as a stable block after the rules. Version the prompt (`PROMPT_VERSION`) and record it in eval reports.

## 6. Speech-to-text (voice notes)
- Interface: `SpeechToText.transcribe(audio: Buffer, mime: "audio/ogg", hint?: Lang): Promise<{text: string, lang?: string, confidence?: number}>`. WhatsApp voice notes are OGG/Opus.
- **Default on AWS: Amazon Transcribe streaming** (`@aws-sdk/client-transcribe-streaming`, region `ap-south-1`). It takes `ogg-opus` media encoding directly (no conversion), and uses language identification over `en-IN, hi-IN`. Audio is streamed from the in-memory Buffer. AI-services opt-out: set the AWS Organizations AI services opt-out policy so content isn't stored or used to improve the service.
- **Quality guard:** if Transcribe's confidence is low (average < 0.6) or the transcript has fewer than 2 words, and `STT_FALLBACK` is configured, retry once with the fallback provider. Otherwise reply `VOICE_UNCLEAR`.
- Adapters: `transcribe` (default), `sarvam` (Sarvam AI, strong on Hinglish and code-mixed speech; India-hosted), `openai-compat` (self-hosted **Whisper / faster-whisper** server, the open-source option), `mock`.
- Choose by eval: record 30 real Hinglish voice samples (staff volunteers, no health content) and compare word accuracy for dates, times and names.
- Limits: audio over 2 min or 5 MB gets `VOICE_TOO_LONG`.

## 7. Evaluation set (`packages/core/extract/eval/cases.jsonl`, aim for 120+ cases)
Each case: `{text, state, ctx, expect: {partial Extraction}}`. Run with `npm run eval:extract -- --provider <spec>` (real API, costs money, run manually). The CI uses recorded fixtures.
**Targets:** intent accuracy ≥ 95%; date/time exact match ≥ 95% on cases that have them; `hasNonBookingContent` recall 100% (no misses on medical-content cases); `possibleEmergency` recall 100% on emergency cases. A false-positive rate ≤ 10% is acceptable.
Seed cases (today = Fri 2026-10-10):
| # | Text | State | Expect |
|---|---|---|---|
| 1 | need appointment tomorrow evening for my mother | IDLE | BOOK, 2026-10-11, evening, existing_profile P2 (MOTHER) |
| 2 | kal shaam 6 baje ke aas paas | BK_WHEN | PROVIDE, 2026-10-11, 18:00, around, hinglish |
| 3 | 6:10 | BK_PICK_SLOT | PROVIDE, time 18:10 |
| 4 | Monday morning | IDLE | BOOK, 2026-10-13, morning |
| 5 | parso subah 11 baje papa ke liye | IDLE | BOOK, 2026-10-12, 11:00, new_person relation FATHER |
| 6 | मुझे कल सुबह दिखाना है | IDLE | BOOK, 2026-10-11, morning, self, hi |
| 7 | appointment for my son Aarav on Saturday after 5 | IDLE | BOOK, 2026-10-11, 17:00 after, new_person "Aarav" SON |
| 8 | cancel my appointment | IDLE | CANCEL |
| 9 | nahi aa paunga kal | IDLE | CANCEL, date 2026-10-11 |
| 10 | shift it to Monday evening | IDLE | RESCHEDULE, 2026-10-13, evening |
| 11 | mera number kab aayega? | IDLE | STATUS, hinglish |
| 12 | how many people before me | IDLE | STATUS |
| 13 | reached | IDLE | ARRIVED |
| 14 | clinic pahunch gaya hoon | IDLE | ARRIVED |
| 15 | what are the timings on Sunday | IDLE | CLINIC_INFO timings |
| 16 | fees kitni hai | IDLE | CLINIC_INFO fees |
| 17 | I have fever since 3 days, which slot is better | BK_PICK_SLOT | OTHER or PROVIDE, hasNonBookingContent=true |
| 18 | kal subah appointment chahiye, bukhar hai teen din se | IDLE | BOOK, 2026-10-11, morning, hasNonBookingContent=true |
| 19 | sugar high hai, medicine change karni hai, follow up | IDLE | BOOK, FOLLOW_UP, hasNonBookingContent=true |
| 20 | papa ko chest pain ho raha hai abhi | any | possibleEmergency=true, hasNonBookingContent=true |
| 21 | saans lene mein dikkat ho rahi hai | any | possibleEmergency=true |
| 22 | report dikhani hai | BK_VISIT_TYPE | PROVIDE, REPORT_SHOW |
| 23 | follow up | BK_VISIT_TYPE | PROVIDE, FOLLOW_UP |
| 24 | haan theek hai | CX_CONFIRM | AFFIRM |
| 25 | no, I need 6 pm only | BK_PICK_SLOT | DENY, time 18:00 |
| 26 | 9876543210 | AWAIT_ALT_NUMBER | PROVIDE, phone 9876543210 |
| 27 | delete my data | IDLE | DELETE_DATA |
| 28 | stop sending messages | IDLE | STOP |
| 29 | thank you so much | IDLE | THANKS |
| 30 | can you tell me what medicine to take for cough | IDLE | OTHER, hasNonBookingContent=true |
| 31 | 6 | BK_WHEN (evening context) | PROVIDE, 18:00 |
| 32 | anytime after 7 tomorrow | IDLE | BOOK, 2026-10-11, 19:00 after |
| 33 | aaj ka mil sakta hai kya | IDLE | BOOK, 2026-10-10 |
| 34 | next Monday | BK_WHEN | PROVIDE, 2026-10-13 |
| 35 | kal aaya tha, dobara aana hai Tuesday | IDLE | BOOK, 2026-10-14, FOLLOW_UP |
| 36 | my name is Anil Verma | WALKIN_ASK_NAME | PROVIDE, selfName "Anil Verma" |
| 37 | for wife | BK_WHO | PROVIDE, new_person SPOUSE |
| 38 | talk to receptionist | IDLE | TALK_TO_STAFF |
| 39 | hindi mein baat karo | IDLE | CHANGE_LANGUAGE, hi |
| 40 | ok | BK_PICK_SLOT (one slot offered) | AFFIRM |
Expand with: typos, mixed scripts, voice-transcript noise ("kal sham che baje"), multi-intent messages ("cancel tomorrow and book Monday"), the past tense ("kal aaya tha"), and many medical-leak variants (organs, tests, drugs, pregnancy, mental health).
