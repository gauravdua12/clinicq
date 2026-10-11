# WhatsApp integration (Meta Cloud API, direct)

> At build time, check the current Graph API version, Flow JSON version and component list against Meta's docs. They change several times a year. Pin them in env (`WA_GRAPH_VERSION`) and in the Flow JSON.

## 1. One-time setup checklist (the clinic owner does this with help)
1. Create a **Meta Business portfolio** (business.facebook.com) for the clinic. Add the legal name and address.
2. **Business verification** (upload a clinic registration, GST or establishment certificate). This raises messaging limits and allows a display name.
3. Create a **Meta developer app** (type: Business) → add the **WhatsApp** product.
4. Add a **dedicated phone number** (a new SIM or landline that isn't used on the WhatsApp app). Verify by SMS or voice.
5. **Display name:** "Dr. Sharma's Clinic" (must match the business; pending approval).
6. Create a **System User** (admin) → generate a **permanent access token** with `whatsapp_business_messaging` and `whatsapp_business_management` → `WA_ACCESS_TOKEN`.
7. Note `WA_PHONE_NUMBER_ID` and `WA_BUSINESS_ACCOUNT_ID`.
8. **Webhook:** callback `https://<domain>/webhook`, verify token `META_VERIFY_TOKEN`. Subscribe to the `messages` field. Copy the App Secret → `META_APP_SECRET`.
9. **Payment method** on the WhatsApp account (for utility template charges).
10. Submit the **message templates** (§5) in English and Hindi. Approval usually takes minutes to hours.
11. **Flows:** generate an RSA-2048 key pair, upload the public key (`POST /{phone-number-id}/whatsapp_business_encryption`), create the booking Flow (§6), set its endpoint URI `https://<domain>/flow`, and publish → `WA_FLOW_ID_BOOKING`.
12. Business profile: about text, address, hours, website (privacy notice), profile photo (clinic logo).
13. Use **Meta's test number** and sandbox for development before switching to the real number.

## 2. Webhook
- `GET /webhook`: respond with `hub.challenge` when `hub.mode=subscribe` and `hub.verify_token` matches.
- `POST /webhook`: verify `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(rawBody, META_APP_SECRET)>` with a constant-time compare. Fastify needs a raw-body plugin for this route.
- Parse with zod: `entry[].changes[].value.{messages[], statuses[], contacts[]}`.
  - `contacts[0].profile.name` → WhatsApp profile name; `messages[].from` → `wa_id` (e.g., `919876543210`).
  - Message types: `text`, `interactive` (`button_reply.id` / `list_reply.id` / `nfm_reply.response_json` for Flows), `button` (template quick-reply payload), `audio` (voice: `audio.voice=true`, `audio.id`), `image|document|video|sticker|location|contacts|reaction`, `unsupported`.
  - `statuses[]`: sent / delivered / read / failed → update `MessageLog.status`. On `failed`, check the error code (e.g., 131047: re-engagement needed outside the 24-hour window → fall back to the template).
- **Dedupe:** insert `ProcessedMessage(wamid)` and ignore a unique violation (Meta retries).
- **Order:** process per-sender sequentially (pg-boss `singletonKey = from`) to keep conversation order.
- Mark messages as read (`status: read`) after handling; optionally show a typing indicator while extracting.

## 3. Sending
`POST https://graph.facebook.com/{WA_GRAPH_VERSION}/{WA_PHONE_NUMBER_ID}/messages` (Bearer token).
| Need | Message type | Limits (validate in builders) |
|---|---|---|
| Plain reply | `text` (preview_url for Maps) | body ≤ 4096 |
| ≤ 3 choices | `interactive.type=button` | 3 buttons, title ≤ 20 chars, id ≤ 256, body ≤ 1024 |
| 4–10 choices | `interactive.type=list` | button label ≤ 20, ≤ 10 rows total, row title ≤ 24, description ≤ 72, section title ≤ 24 |
| Booking form | `interactive.type=flow` | flow_id, flow_cta ≤ 20 chars, `flow_action: data_exchange` |
| Link button | `interactive.type=cta_url` | display_text ≤ 20 |
| Clinic contact | `contacts` | name + phone (tap to call or save) |
| Location | `location` | clinic lat/long + address |
| Outside 24h | `template` | approved name + language + components |
**Window logic** (`wa.Sender.send(accountId, copyId | template)`): if `lastInboundAt > now − 24h`, send a session message. Otherwise send the mapped template. If no template is mapped, drop the message and log `skipped_outside_window`.
**Button IDs** encode intent and state, e.g. `slot:2026-10-11T12:40:00Z`, `vt:NEW`, `consent:yes`, `num:use`, `ovf:<requestId>:yes`. Never put personal data in IDs.
**Rate:** respect the per-number throughput (about 80 msg/s, far above our needs) and the business-initiated daily tier limits. A per-account outbound limiter avoids spam bursts.

## 4. Media handling
- `audio` (voice note): `GET /{media-id}` → `url` → `GET url` (with Bearer) into a **Buffer** (max 5 MB, 2 min). Pass to STT. Never write it to disk. Dereference it after use.
- `image | document | video | sticker`: **never call the media endpoints.** Reply `MEDIA_REPORTS` (or OTHER_HELP for stickers).
- `location`: ignore the coordinates and reply with clinic info.

## 5. Message templates (category: UTILITY, unless stated)
Submit each in `en` and `hi`. Variables are positional. Keep wording non-promotional: no offers, no "visit us", no health claims. The Hindi text mirrors the English.
| Name | Body (en) | Buttons |
|---|---|---|
| `booking_confirmation` (key `appointment_confirmed`) | "Booking confirmed. Patient: {{1}} / Date: {{2}} / Time: {{3}} / Token number: {{4}} / Clinic: {{5}} / To reschedule or cancel this booking, tap a button below." | QR: Reschedule, Cancel |
| `reminder_24h` | "Reminder: {{1}} ji, your appointment with {{2}} is tomorrow, {{3}} at {{4}} (Token {{5}})." | QR: Confirm, Reschedule, Cancel |
| `reminder_same_day` | "Today at {{1}}: {{2}} ji's appointment (Token {{3}}). Doctor is {{4}}. Location: {{5}}" | QR: Running late, Cancel |
| `cancelled_by_clinic` | "Sorry {{1}} ji, Doctor is unavailable on {{2}}. Your {{3}} appointment is cancelled. Please pick a new time or call {{4}}." | QR: Pick new time; PHONE_NUMBER: Call clinic |
| `doctor_running_late` | "Update for {{1}} ji: Doctor is running about {{2}} minutes behind today. Your new estimated time is around {{3}}." | |
| `turn_near` | "{{1}} ji, your turn is coming up soon. {{2}} patients ahead of you (about {{3}} min)." | QR: Check status |
| `your_turn` | "{{1}} ji, it's your turn now. Please proceed to Doctor's cabin." | |
| `walkin_token` | "Token {{1}} for {{2}} ji at {{3}}. {{4}} patients ahead, about {{5}} min." | QR: Check status |
| `followup_due` (Phase 2) | "{{1}} ji, your follow-up visit with {{2}} is due on {{3}}." | QR: Book now |
| `staff_walkin_overflow` | "Walk-in quota full for the {{1}} session. {{2}} ({{3}}) is at reception. Can you adjust?" | QR: Yes adjust, No |
| `daily_summary` (Phase 2) | "Today at {{1}}: {{2}} booked, {{3}} walk-ins, {{4}} completed, {{5}} no-shows, average wait {{6}} min." | |
| `no_show_rebook` | "We missed you today, {{1}} ji. Reply to book another time." | QR: Book again |
| `staff_login_otp` (AUTHENTICATION) | Meta's fixed auth format: "{{1}} is your verification code." | COPY_CODE |
Walk-in alerts are normally sent inside the 24-hour window, because the patient just messaged. The templates are the fallback.
**Template health:** an hourly job reads template status and phone quality. If a template is paused or the quality is low, alert the doctor and switch to session messages only where possible.

## 6. Booking Flow ("form D")
### 6.1 Screens
1. **PICK_DATE_SLOT**
   - Heading: "Choose date and time" (localised).
   - `date` selector: chips (`ChipsSelector`) or `RadioButtonsGroup` with the next `windowDays` dates ("Sat 11 Oct"). Closed dates are omitted or marked "Closed" with `enabled:false`. *(If the CalendarPicker component is available in the pinned Flow JSON version, it may be used with `unavailable-dates`.)*
   - On date change → `data_exchange` (`action: "date_selected"`) → the endpoint returns the slots for that date.
   - `slot` selector: `RadioButtonsGroup` grouped by "Morning" / "Evening" (two groups, or a section title per group via `TextSubheading`). Only free slots are listed; if none, show "No free times on this day".
   - Footer: **Continue** → `data_exchange` (`action: "slot_selected"`).
2. **CONFIRM**
   - Summary: patient name, date, time, clinic.
   - Footer: **Confirm booking** → `complete` with payload `{slotStart, profileRef}`.
   Visit type stays in chat (asked after the Flow, if unknown), to keep the Flow short.
### 6.2 Data endpoint `POST /flow`
- Request body `{encrypted_flow_data, encrypted_aes_key, initial_vector}` (base64).
- Decrypt the AES key with the RSA private key (`RSA_PKCS1_OAEP_PADDING`, `oaepHash: sha256`). Decrypt `encrypted_flow_data` with **AES-128-GCM** (the last 16 bytes are the auth tag) and `initial_vector`.
- Payload `{version, action: "ping"|"INIT"|"data_exchange"|"BACK", screen, data, flow_token}`.
  - `ping` → `{data: {status: "active"}}` (health check).
  - `INIT` → initial date list and the default date's slots.
  - `data_exchange` (`date_selected`) → `{screen: "PICK_DATE_SLOT", data: {slots: [...]}}`.
  - `data_exchange` (`slot_selected`) → **re-check availability and place the hold**. If taken → return the same screen with an `error_message` ("That time was just taken. Please pick another.") and refreshed slots. If OK → `{screen: "CONFIRM", data: {...summary}}`.
- Response: JSON → AES-128-GCM encrypt with the same key and the **bitwise-inverted IV** → base64 string, `Content-Type: text/plain`.
- `flow_token`: an opaque random token mapped server-side to `{accountId, profileId, conversationId}`, with a TTL of 15 min. It never contains personal data.
- Errors: return HTTP 421 if decryption fails (the client re-fetches the public key), and 432 for a request signature failure where applicable (follow Meta's current spec).
- Signature: Meta signs Flow endpoint requests with `X-Hub-Signature-256` too, so verify it.
### 6.3 Completion
The `nfm_reply` webhook message arrives in chat with `response_json` (`{slotStart, flow_token}`). The bot continues with the visit type, then confirms. The hold placed at `slot_selected` is converted to BOOKED.
### 6.4 Fallback to the list picker (form C)
Use the list picker if: the Flow send fails (API error), the patient types "can't open" / "not opening", the Flow isn't completed within 10 min (send one gentle nudge with the list), or `flowsEnabled=false` in settings.

## 7. Mock and simulator (dev)
- `WA_MODE=mock`: `MockWhatsApp` implements the same interface as `CloudApiClient` and stores outbound messages in memory. It emits them on an SSE channel for the simulator.
- `/dev/simulator` (built only when dev tools are enabled): a phone-like chat UI. Pick a fake patient number and name, type or tap buttons, "send voice note" (a text box that feeds the mock STT), "send image". It posts signed webhook payloads to `/webhook` exactly like Meta, so the real code path is exercised. A second panel shows the staff phone (for overflow and commands).
- Flow simulation: the simulator renders the Flow screens from the same Flow JSON and calls `/flow` with real encryption, using a dev key pair.

## Booking page (form D), added 11 Oct 2026
WhatsApp's native Flows cap selectors at about 20 options and can't scroll sideways, and Meta blocks unpublished Flows until business verification. So form D is a **page opened from a `cta_url` button** (an interactive message, allowed in the 24 h window, no template needed): `https://<host>/book?t=<token>`.
- **Token:** a `FlowToken` row. It names the account and profile, lasts 30 minutes, and works for one booking. The page shows only the patient's first name.
- **API:**
  - `GET /api/book/:t` loads the clinic, the week and the visit types.
  - `GET /api/book/:t/day/:date` loads every slot of the day, with booked ones flagged.
  - `POST /api/book/:t/confirm` books through the same path as the chat (`bookFromPage`, serialised with the patient's messages). It sends the WhatsApp confirmation, or returns 409 with fresh slots if the slot was taken meanwhile.
- **If the button can't be delivered** to a patient, that chat falls back to the list picker (C) for an hour.
- **The native Flow** is still supported: set `BOOKING_PAGE=false` with `WA_FLOW_ID_BOOKING`.
