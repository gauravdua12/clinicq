# Data policy: logistics only

> Not legal advice. This is the engineering policy the code must follow. Have a lawyer review §7 (the privacy notice) before go-live.

## 1. Roles (DPDP Act 2023 / DPDP Rules 2025)
- **Data Fiduciary:** the clinic (the doctor). It decides why and how data is processed.
- **Data Processors:** the ClinicQ operator (software), AWS (hosting, Amazon Bedrock for text understanding, Amazon Transcribe for voice notes, all in India regions), Meta (WhatsApp transport), Razorpay (payments, Phase 2). Any optional providers in use (Sarvam AI, Anthropic API, a self-hosted model server) are also named. All of them appear in the privacy notice.
- **Data Principal:** the patient. For a minor, the guardian consents and acts for them.
- **Timeline:** DPDP substantive duties apply from **14 May 2027**. We build to that standard now. SPDI Rules 2011 apply until then; by not storing health data we stay outside the "sensitive personal data" category.

## 2. Allowed fields (exhaustive; adding a field needs a change to this doc first)
| Entity | Field | Notes |
|---|---|---|
| PatientAccount | channel, waPhone (encrypted), phoneHash, waProfileName (encrypted), language, numberConfirmedAt, optedOutAt | The WhatsApp number is the identity, per clinic number (`channel`): each clinic's patients are separate |
| PatientProfile | name (encrypted), relation enum, yearOfBirth?, gender?, contactPhone? (encrypted) | yob and gender are optional and only used to tell family members apart |
| ConsentRecord | noticeVersion, language, givenAt, withdrawnAt, channel | |
| Appointment | profileId, slotStart, visitType enum, status, token, source, timestamps, fee status | **No reason or notes field** |
| QueueEntry | token, state, timestamps, expectedAt, position overrides | |
| WalkinOverflowRequest | profileId, decision, decidedBy, assignedTime | |
| FollowUp | profileId, doctorId, dueDate, remindedAt, bookedAppointmentId, cancelledAt, createdById | **No reason** |
| PaymentDue | profileId, doctorId, visitDate, amountPaise, status (PENDING/PAID/CANCELLED), payToken, reminder counts, claimedPaidAt, paidAt | **No reason, description or bill items.** The patient pays the clinic directly (UPI or at the clinic); no UPI or card details are stored |
| Payment | provider order ID, amount, status, refund status | No UPI or card details |
| WaConnection (customer clinics) | WhatsApp Business Account id, phone number id, display number, verified name, business token (encrypted), registration PIN (encrypted), status, who connected it (name), status check | Clinic data from Meta; the token is wiped on disconnect |
| MessageLog | direction, templateName or copyId, wamid, status, timestamps | **No message body** |
| AuditLog | actor, action, entity, entityId, timestamp, small diff of logistics fields | |

## 3. Forbidden: never stored anywhere (DB, logs, jobs, files, error trackers)
- Raw inbound message text, captions, voice audio and transcripts.
- Images, PDFs, documents and videos sent by patients. **These are never downloaded.**
- Symptoms, complaints, diagnosis, medicines, test names, reports, vitals, allergies, history, insurance, ABHA.
- Free-text "reason for visit" or "notes" of any kind.
- LLM prompts or responses that contain patient text. Extraction calls are not logged; only `latencyMs` and `intent` are.

## 4. How the boundary is enforced in code
1. **Ingress:** the webhook route extracts structured fields from text *before* anything is persisted or enqueued (ARCHITECTURE §3.1).
2. **Media:** an allow-list. `audio` is downloaded to memory for speech-to-text; `image/document/video/sticker` are never fetched.
3. **Redacting logger** strips the keys `text, body, caption, transcript, message, content, phone, waPhone, name`, and any string matching an Indian mobile pattern.
4. **Extractor flag** `hasNonBookingContent` triggers the courteous health-details reply (CONVERSATION_GUIDE `HEALTH_DETAILS_REDIRECT`). The content itself is discarded.
5. **Schema guard test:** CI fails if any Prisma model gains a `String` field named like `reason|note|symptom|complaint|diagnos|medic|report|history|description|remark`.
6. **Boundary test suite** (TESTING §5): sends sensitive canary strings and then scans every table, the pg-boss tables and the log output for them.
7. **Error tracking** (if added later) must use the same redaction hook before sending.

## 5. Retention (purge job, daily 02:30 IST)
| Data | Retention | Action |
|---|---|---|
| ConversationState | 30 min after last message | delete |
| Slot holds | 5–10 min | release |
| MessageLog | 90 days | delete |
| Appointment / QueueEntry | 180 days after visit | anonymise: drop profileId, keep date/slot/status/source for aggregate reports |
| PatientProfile / PatientAccount | 12 months after last activity | delete (cascade; anonymise linked visits first) |
| Payment | 8 years (tax and accounting law) | keep amount, date, order ID; unlink from profile after 180 days |
| FollowUp | 180 days after the due date | delete |
| WaConnection | token: at once on disconnect; ids: 30 days after disconnect | wipe / delete |
| PaymentDue | 180 days after the visit, once paid or cancelled (pending ones stay until settled) | delete. The clinic's own accounts are its record of payment |
| AuditLog | 1 year | delete |
| ConsentRecord | life of account + 1 year | delete |
| Backups | 14 days rolling | deleted data disappears from backups within 14 days |

All retention periods are configurable in `Clinic.settings.retention`, with these as the minimum defaults.

## 6. Patient rights flows (via WhatsApp, in plain words)
| Request | Example phrases | Behaviour |
|---|---|---|
| Access | "show my data", "mera data dikhao" | Send the stored fields for the account and profiles (names, numbers masked except their own, upcoming appointments, consent date) |
| Correction | "change my name", "wrong number" | Guided update of name or contact number |
| Erasure | "delete my data", "mera data delete karo" | Confirm [Yes, delete] [Keep]. Cancel future appointments, anonymise past visits, delete profiles and account, keep only legally required payment records. Reply confirming. Write a `DataRequest` row (no personal content) |
| Withdraw consent / opt-out | "stop", "unsubscribe", "band karo" | Mark optedOut. Only transactional replies to messages the patient sends themselves. No reminders. Rejoin by saying "start" |
| Grievance | "complaint", "privacy" | Show the clinic's grievance contact (name, email, phone) from settings |
Response time for each: immediate (automated). Complex cases are flagged to the doctor on the dashboard.

## 7. Privacy notice drafts
**Short version (in chat, at first contact).** EN:
> Before we start: to manage your visit, Dr. Sharma's Clinic saves only your name, phone number and appointment details. We don't keep any health information shared here. You can see or delete your data anytime by typing "my data". Full notice: {{noticeUrl}}

HI:
> शुरू करने से पहले: आपकी विज़िट मैनेज करने के लिए डॉ. शर्मा क्लिनिक केवल आपका नाम, फ़ोन नंबर और अपॉइंटमेंट की जानकारी सेव करता है। यहाँ शेयर की गई कोई भी स्वास्थ्य जानकारी हम नहीं रखते। अपना डेटा देखने या हटाने के लिए कभी भी "my data" लिखें। पूरी जानकारी: {{noticeUrl}}

**Full notice**: published as the ClinicQ Privacy Policy at `/privacy` (operator: Incolo Systems; also `/data-deletion` and `/terms`; grievance email from `GRIEVANCE_EMAIL`, default customercare@incolosystems.com). It covers:
1. Who we are (the clinic as Data Fiduciary, with contact details).
2. What we collect (§2 table in plain words) and what we don't (§3).
3. Why (booking, reminders, queue updates, follow-up reminders) and the legal basis (consent).
4. Who processes it (Meta/WhatsApp; AWS in India for hosting, message understanding (Amazon Bedrock) and voice notes (Amazon Transcribe); Razorpay if fees are enabled). Processors don't keep the content of message-understanding or transcription requests.
5. How long we keep it (§5).
6. Your rights (§6) and how to use them. Grievance officer contact. Right to complain to the Data Protection Board of India.
7. Children: a guardian books for and consents on behalf of minors.
8. Security measures (summary).
9. Changes to the notice (new version → re-consent prompt).

## 8. Processor configuration requirements
- **Amazon Bedrock:** prompts and completions aren't stored or used for training by default. **Keep model-invocation logging disabled.** Use only in-region models (gpt-oss in ap-south-1) or the India geo profile for Claude (`in.` prefix, Mumbai + Hyderabad), so text never leaves India. Send only the message text plus minimal context (today's date, clinic sessions). **Never send the phone number or stored profile names.** Instead, pass profiles as opaque labels (`P1: relation=MOTHER`).
- **Amazon Transcribe:** streaming API (no S3 storage). Apply the AWS Organizations **AI services opt-out policy** for Transcribe and Bedrock.
- **Optional providers** (Sarvam, Anthropic API, a self-hosted model): confirm no-retention terms and the hosting location before enabling, and record them in DEPLOYMENT §7.
- **Meta:** WhatsApp Cloud API. Messages pass through Meta as the transport; covered by WhatsApp Business terms.
- **Hosting:** an India region (Mumbai or Bangalore).

## 9. Breach response (72 hours)
1. Contain: rotate keys (`DATA_KEY` re-encrypt, WhatsApp token, Anthropic key), revoke sessions.
2. Assess: what data and whose (only logistics data exists by design).
3. Notify the Data Protection Board and affected patients within 72 hours (from May 2027; best practice now). Template text lives in `docs/runbooks/breach.md` (to be written in Milestone 9).
4. Post-mortem and fix.
