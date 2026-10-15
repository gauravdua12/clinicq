# Conversation guide

The bot should feel like a warm, efficient receptionist. Everything here is the **approved spec**. The six scenarios in §7 are the acceptance scripts (see `docs/mockups/booking-ui.html`).

## 1. Voice and tone
- **Warm, respectful, brief.** Use the name with "ji" ("Ramesh ji", "Sunita ji"). Use one emoji at most per message, and only from 🙏 😊 ✅ 📍 📞 ⏰.
- **Mirror the patient's language.** Each message's extracted `lang` ∈ `en | hi | hinglish` sets the reply language. If it's ambiguous, keep the last language. Devanagari input → `hi`. Roman Hindi → `hinglish`.
- **Never shut the patient down.** Redirect politely and always offer the next step (book, status, call clinic).
- **Never give medical advice**, never comment on symptoms, never suggest urgency except the emergency copy.
- **One question per message.** Don't ask for things we already know (number, name, profile).
- **Vary phrasing.** Each copy ID has 2–3 variants; pick one at random (seeded per conversation) so the bot doesn't feel robotic.
- **Buttons are shortcuts, not gates.** Every question can also be answered by typing or voice.
- **WhatsApp limits:** reply-button titles ≤ 20 chars (max 3 buttons); list row titles ≤ 24 chars; body ≤ 1024 chars.

## 2. Information disclaimer (not a shutdown)
Shown in the welcome message and in HELP:
- EN: "I'm the appointment assistant for {{clinicName}}. I can help you book, reschedule or check your turn in the queue. Medical advice is given by Doctor during your consultation."
- HI: "मैं {{clinicName}} की अपॉइंटमेंट असिस्टेंट हूँ। मैं बुकिंग, री-शेड्यूल या कतार में आपकी बारी बताने में मदद कर सकती हूँ। डॉक्टर की सलाह कंसल्टेशन के दौरान ही दी जाती है।"
- Hinglish: "Main {{clinicName}} ki appointment assistant hoon. Booking, reschedule ya queue mein aapki baari batane mein madad kar sakti hoon. Medical salah Doctor consultation ke dauran hi dete hain."

## 3. Intents (from the extractor, see AI_EXTRACTION)
| Intent | Examples | Handler |
|---|---|---|
| `GREETING` | hi, hello, namaste | welcome / main menu |
| `BOOK` | need appointment, kal ka time do, book for mummy | booking flow |
| `RESCHEDULE` | shift to Monday, time change karna hai | reschedule flow |
| `CANCEL` | cancel my appointment, nahi aa paunga | cancel flow |
| `STATUS` | mera number kab aayega, how long, status | queue status |
| `ARRIVED` | I've reached, pahunch gaya, at clinic | check-in |
| `MY_APPOINTMENTS` | my bookings, kab ka hai mera | list upcoming |
| `CLINIC_INFO` | timings, address, fees, Sunday open? | info reply (from settings) |
| `TALK_TO_STAFF` | talk to someone, call me, receptionist | clinic phone + notify staff |
| `MY_DATA` / `DELETE_DATA` / `STOP` / `START` | see DATA_POLICY §6 | privacy flows |
| `CHANGE_NUMBER` / `CHANGE_LANGUAGE` | | settings flows |
| `PROVIDE` | answers to the current question (a time, a name, "6:30", "for my son") | current state's handler |
| `AFFIRM` / `DENY` | haan, ok, yes / nahi, no | current state's handler |
| `THANKS` | thank you, dhanyavaad | short warm close |
| `WAIT` | hold, wait, ek minute, ruko, baad mein batata hoon | "take your time"; the pending question is kept (not repeated) |
| `RUDE` | stupid, useless, bakwas, pagal ho kya, "stop it now", "stop repeating" | apology + what I can do + clinic phone, then the pending question (never an unsubscribe) |
| `HELP` | what can you do, who are you, are you a bot | what I can do, then the pending question or the menu |
| `END` | don't want to book, no thanks, nothing, never mind, bye, that's all, close/end the chat, stop the booking, wrong number, nahi chahiye, kuch nahi, rehne do | a close that fits the moment (see "Declining and leaving"); never the menu, never an unsubscribe |
| `OTHER` | anything else | mid-way: "Sorry, I didn't understand" + the question; idle: apology + what I can do + menu |
Walk-in starts from the QR text pattern `WALKIN <CODE>-<DAILY>` (rule-based, not LLM).
Flags: `hasNonBookingContent` (health details), `isEmergency` (from the keyword matcher, see §6.9).

## 4. Conversation states
```
NEW ─▶ AWAIT_CONSENT ─▶ AWAIT_NUMBER_CONFIRM ─▶ (AWAIT_ALT_NUMBER) ─▶ IDLE
IDLE ─BOOK▶ BK_WHO ─▶ (BK_NAME) ─▶ BK_WHEN ─▶ BK_PICK_SLOT ─▶ (BK_FLOW_OPEN) ─▶ BK_VISIT_TYPE ─▶ (BK_PAYMENT) ─▶ IDLE
IDLE ─RESCHEDULE▶ RS_PICK_APPT ─▶ BK_WHEN … ─▶ IDLE
IDLE ─CANCEL▶ CX_PICK_APPT (2+ bookings) ─▶ CX_CONFIRM (one) / CX_CONFIRM_MANY (several) ─▶ IDLE
IDLE ─WALKIN code▶ (number/name) ─▶ WI_ISSUE | WI_AWAIT_STAFF ─▶ IDLE | BK_PICK_SLOT
IDLE ─DELETE_DATA▶ ERASE_CONFIRM ─▶ IDLE
```
- Skip any state whose data is already known: e.g., "book tomorrow 6 pm for me" goes straight to BK_PICK_SLOT.
- Global intents (STATUS, CANCEL, CLINIC_INFO, STOP, emergency) work from any state. After answering, the bot resumes the open question with `RESUME_PROMPT`.
- State expires after 30 min of silence → IDLE (known data like consent, number and profiles is kept).

## 5. Booking rules applied in conversation
1. **Who:** if the account has one profile and the text says nothing about who, assume "me" but say the name in the confirmation, so a mistake is visible. If there are multiple profiles and it's unclear, ask `ASK_WHO` with up to 3 profile buttons (max 2 profiles + "Someone else").
2. **When:** if the extractor gives a date and time → smart suggest. Date only → the 2 earliest free slots that day. Part of day only → that session. Nothing → `ASK_WHEN`.
3. **Smart suggest** (QUEUE_ENGINE §2.3) returns 0–2 near slots:
   - 2 or 1 near → `OFFER_NEAR_SLOTS`: buttons for the slots plus [See all slots].
   - 0 near → `NO_NEAR_SLOTS` + Flow message (form D). If the Flow fails, use the list picker (C).
4. A typed time while in BK_PICK_SLOT: free → take it; taken → `SLOT_TAKEN_TYPED` + new near offers.
5. **Hold** the chosen slot for 5 min. If visit type isn't answered in time, release the slot and send `HOLD_EXPIRED`.
6. **Visit type:** inferred if the text says "follow up" or "report dikhana"; otherwise `ASK_VISIT_TYPE`.
7. **Confirm** → `BOOKING_CONFIRMED`. Schedule reminders.

## 6. Copy bank (IDs → EN / HI / Hinglish). Variables use `{{ }}`.
> Implement in `packages/core/copy/*.ts`. EN is the source of truth; HI and Hinglish must keep the same meaning and buttons. Two variants are shown where useful (v1 / v2).

### 6.1 Onboarding
**WELCOME_CONSENT**
- EN: "Hello! 👋 I'm the appointment assistant for {{clinicName}}. I can help you book, reschedule or check your turn. Medical advice is given by Doctor during your consultation.\n\nBefore we start: we save only your name, number and appointment details to manage your visit. Privacy notice: {{noticeUrl}}"
  Buttons: [I agree, continue]
- HI: "नमस्ते! 👋 मैं {{clinicName}} की अपॉइंटमेंट असिस्टेंट हूँ… (as §2) …\n\nशुरू करने से पहले: आपकी विज़िट के लिए हम केवल नाम, नंबर और अपॉइंटमेंट की जानकारी रखते हैं। प्राइवेसी नोटिस: {{noticeUrl}}" Buttons: [सहमत हूँ, आगे बढ़ें]
- Hinglish: "Namaste! 👋 Main {{clinicName}} ki appointment assistant hoon… Shuru karne se pehle: hum sirf aapka naam, number aur appointment details rakhte hain. Privacy notice: {{noticeUrl}}" Buttons: [Agree, aage badhein]

**CONSENT_DECLINED**: EN: "No problem. Without this I can't book online, but you're welcome to call the clinic at {{clinicPhone}} 📞."

**CONFIRM_NUMBER**
- EN v1: "Thank you, {{waName}} ji. I'll book this with your number {{waPhone}}. Is that okay?" Buttons: [Use {{waPhoneShort}}] [Different number]
- HI: "धन्यवाद, {{waName}} जी। मैं यह बुकिंग आपके नंबर {{waPhone}} से करूँगी। ठीक है?" Buttons: [यही नंबर] [दूसरा नंबर]
- Hinglish: "Thank you {{waName}} ji. Booking aapke number {{waPhone}} se kar doon?" Buttons: [Haan, yahi number] [Doosra number]
  *(`waPhoneShort` = "+91 98765 43210" (16 chars), so the button "Use +91 98765 43210" is 19 chars ✓.)*

**ASK_ALT_NUMBER**: EN: "Sure, please type the 10-digit mobile number you'd like us to use." → invalid: "That doesn't look like a 10-digit mobile number. Could you check once?" → saved: "Saved ✅ We'll use {{altPhone}} as the contact number. Updates will still come on this WhatsApp chat."

### 6.2 Booking
**ASK_WHO**: EN: "Is this appointment for you or someone else?" Buttons: [For me] [{{profile2}}] [Someone else]
- Hinglish: "Appointment aapke liye hai ya kisi aur ke liye?"

**ASK_NAME_OTHER**: EN: "Sure. What's the patient's name? (You can also add relation, like 'my mother Sunita')"

**ACK_PROFILE**: EN: "Got it, booking for {{name}} ji."

**ASK_WHEN**
- EN v1: "Which day and time suits you? You can type something like \"tomorrow evening\" or \"Monday 11 am\"."
- EN v2: "When would you like to come in? Just tell me the day and roughly what time."
- HI: "आपको कौन सा दिन और समय ठीक रहेगा? जैसे \"कल शाम\" या \"सोमवार 11 बजे\" लिख सकते हैं।"
- Hinglish: "Kaunsa din aur time theek rahega? Jaise \"kal shaam\" ya \"Monday 11 baje\" likh sakte hain."

**OFFER_NEAR_SLOTS**
- EN: "For {{dayLabel}} ({{date}}) {{partOfDay}}, closest to {{requestedTime}}:" Buttons: [{{slot1}}] [{{slot2}}] [See all slots]
- If no time was given: "For {{dayLabel}} ({{date}}), the earliest times are:"
- If it's a returning patient on a day-only request: "{{dayLabel}} ({{date}}) {{partOfDay}}, I have:"
- Hinglish: "{{dayLabel}} ({{date}}) {{partOfDay}}, {{requestedTime}} ke sabse paas yeh time free hain:"

**NO_NEAR_SLOTS** (followed by the Flow message)
- EN: "{{dayLabel}} around {{requestedTime}} is fully booked, sorry. Please pick any free date and time here 👇" Flow CTA: [Choose date & time]
- Hinglish: "{{dayLabel}} {{requestedTime}} ke aas paas sab slots bhar gaye hain. Yahan se koi bhi free din aur time chun lijiye 👇"

**LIST_PICKER_FALLBACK**: EN body: "Pick a time for {{name}} ji:" List button: [View slots]; sections "Morning · {{date}}", "Evening · {{date}}"; rows "5:30 PM".

**SLOT_TAKEN_TYPED**: EN: "{{time}} is already booked, but these are close by:" Buttons: [{{slot1}}] [{{slot2}}] [See all slots]

**ASK_VISIT_TYPE**: EN: "Is this a new consultation or a follow-up?" Buttons: [New consultation] [Follow-up] [Show reports]
- Hinglish: "Yeh nayi consultation hai ya follow-up?" Buttons: [Nayi consultation] [Follow-up] [Report dikhani hai]

**BOOKING_CONFIRMED**
- EN: "Confirmed ✅\n\n*{{name}} ji*\n{{dayShort}} {{date}}, {{time}}\nToken *{{token}}*\n📍 {{clinicName}}, {{addressShort}}\n{{mapsUrl}}\n\nI'll remind you a day before. Reply anytime to reschedule or cancel." Buttons: [Reschedule] [Cancel]
- Hinglish: "Ho gaya ✅ … Ek din pehle yaad dila doongi. Reschedule ya cancel ke liye kabhi bhi message karein."

**HOLD_EXPIRED**: EN: "I held {{time}} for a few minutes, but it's been released now. Shall I check times again?" Buttons: [Check times]

**SLOT_RACE_LOST** (BK-07)
- EN: "Sorry {{name}} ji, {{time}} was taken just now. The nearest available times are:" Buttons: [{{alt1}}] [{{alt2}}] [See all slots]

**SLOT_RACE_DECLINED**
- EN: "I understand. Slots near {{requestedTime}} are full {{dayLabel}}. Would you like to try another day, or call the clinic? Staff will check if anything can be arranged." Buttons: [Try another day] [Call clinic]

**CALL_CLINIC**: EN: "Please call {{clinicName}} at {{clinicPhone}} 📞 ({{sessionHours}}). Tap to call: {{telLink}}"
*(For in-window messages, send the text plus a contact card (`contacts` message). Templates use the PHONE_NUMBER button.)*

**SAME_SLOT_FAMILY** (BK-08): EN: "{{time}} is booked for {{otherName}} ji, and each slot takes one patient. Shall I book {{name}} right after, at {{nextSlot}}?" Buttons: [Book {{nextSlot}}] [See all slots]

**BOOKING_RULE_BLOCKED**
- cut-off: "Online booking for {{time}} has closed (we need {{cutoff}} min notice). The next available times are:" (+ offers)
- closed day: "The clinic is closed on {{date}}. Here are the nearest open days:" (+ Flow)
- too far: "I can book up to {{windowDays}} days ahead. Please pick a date before {{maxDate}}."
- profile limit: "{{name}} ji already has {{n}} upcoming appointments ({{list}}). Shall I reschedule one of those instead?"

### 6.3 Reschedule and cancel
**RS_PICK_APPT** (several upcoming): "Which appointment would you like to change?" List rows: "{{name}} – {{dayShort}} {{time}}".
**RS_DONE**: "Moved ✅ {{name}} ji, {{dayShort}} {{date}}, {{time}}, Token {{token}}. The {{oldTime}} slot is released."
**CX_CONFIRM**: "Cancel {{name}} ji's appointment on {{dayShort}} {{date}} at {{time}}?" Buttons: [Yes, cancel] [Keep it]
**CX_DONE**: "Cancelled. Hope to see you soon 🙏 Message me anytime to book again." (+ refund line if a fee applies)

### 6.4 Reminders (templates, see WHATSAPP_INTEGRATION §5)
`reminder_24h`: "Reminder: {{1}} ji, your appointment with {{2}} is tomorrow, {{3}} at {{4}} (Token {{5}})." Buttons: Confirm / Reschedule / Cancel
`reminder_same_day`: "Today at {{1}}: {{2}} ji's appointment (Token {{3}}). Doctor is {{4}}. Location: {{5}}"
Replies: Confirm → "Thank you, see you tomorrow 😊". Reschedule/Cancel → those flows.

### 6.5 Arrival, queue status, alerts
**ARRIVED_OK**: "Welcome, {{name}} ji 🙏 You're checked in. Token {{token}}, {{ahead}} ahead of you (about {{eta}} min)."
**ARRIVED_EARLY**: "You're a little early, {{name}} ji 😊 Your time is {{time}}. I'll add you to the queue at {{autoCheckIn}}. Please have a seat."
**ARRIVED_NO_BOOKING**: "I don't see a booking for today. Would you like to join today's walk-in queue? Please scan the QR code at reception, or I can check booking times." Buttons: [Check times]
**STATUS**: "Now with Doctor: {{current}}\nYou: {{token}}, {{ahead}} patients ahead\nEstimated wait: about {{eta}} min"
- not yet arrived (booked): "Your appointment is at {{time}} (Token {{token}}). Doctor is {{runningStatus}}. Please let me know when you reach: just say \"reached\"."
- no booking: "You don't have a booking today. Shall I find a time?" Buttons: [Book appointment]
**TURN_NEAR**: "{{name}} ji, your turn is coming up soon. {{ahead}} patients ahead of you (about {{eta}} min). Please stay near the reception."
**YOU_ARE_NEXT**: "{{name}} ji, you're next. Please be ready to go into the cabin."
**YOUR_TURN**: "It's your turn now 🙏 Please proceed to Doctor's cabin."
**DOCTOR_LATE**: "Update: Doctor is running about {{min}} minutes behind. Your new estimated time is around {{newTime}}. Thank you for your patience 🙏"
**DOCTOR_BREAK**: "Doctor is on a short break and will resume in about {{min}} minutes. Your place in the queue is safe."
**NO_SHOW_CALLED**: (when staff marks a called patient No-show) "We called token {{token}} but couldn't find you. Message \"reached\" when you're back and I'll add you to the queue again."
**NO_SHOW_MISSED**: (after the session) "We missed you today, {{name}} ji. Would you like to book another time?" Buttons: [Book again]

### 6.6 Walk-in
**WALKIN_ASK_NAME**: "Welcome to {{clinicName}} 🙏 I'll register you with {{waPhone}}. May I have the patient's name?" Buttons: [Use this number] [Different number] *(+ profile buttons if known: "Ramesh (me)", "Sunita")*
**WALKIN_TOKEN**: "Thank you, {{name}} ji. Your token is *{{token}}*. {{ahead}} patients ahead of you, about {{eta}} min. I'll message you when your turn is near, so feel free to sit comfortably." Buttons: [Check my status]
**WALKIN_CHECKING**: "Thanks, {{name}} ji. Today's walk-in slots are full, so let me check with the reception team. One moment please 🙏"
**WALKIN_ADJUSTED**: "Good news, {{name}} ji. The clinic has made space for you.\n\nToken *{{token}}*, around {{time}}\n{{ahead}} patients ahead of you.\n\nI'll message you when your turn is near." Buttons: [Check my status]
**WALKIN_DECLINED**: "Sorry {{name}} ji, today's walk-in list is full. The next available appointments are:" Buttons: [{{slot1}}] [{{slot2}}] [See all slots] → after offers, add the line "Or call the clinic: {{clinicPhone}}"
**WALKIN_TIMEOUT**: "Reception is busy right now, sorry for the wait. Here are the next available appointment times:" (same as declined)
**WALKIN_BAD_CODE**: "Please scan the QR code at the reception desk to join today's queue 😊 If you'd like to book for another day, just tell me when."

### 6.7 Health details, media, voice
**HEALTH_DETAILS_REDIRECT** (flag `hasNonBookingContent`, combined with the booking step)
- EN v1: "Thank you for sharing, {{name}} ji 🙏 Please keep health details for your consultation. Doctor will go through everything with you in person."
- EN v2: "I hope you feel better soon 🙏 Doctor will go through everything with you in person. I can help with the timing."
- Hinglish: "Aap jaldi theek ho jaayein 🙏 Health ki baatein Doctor consultation mein detail mein dekhenge. Main time fix karne mein madad karti hoon."
→ always followed by the pending booking prompt (e.g., "Shall I book the earliest slot tomorrow, 10:20 AM?").

**MEDIA_REPORTS**: "Please bring your reports with you to the clinic. Doctor will review them during the consultation 😊"
**VOICE_BOOKING_UNDERSTOOD**: "Thank you, {{name}} ji. I understood you'd like an appointment for {{when}}." (+ HEALTH_DETAILS_REDIRECT v-short if flagged: "Any health concerns are best discussed with Doctor during your visit, so I haven't saved those.") (+ offers)
**VOICE_UNCLEAR**: "Sorry, I couldn't catch that clearly. Could you type the day and time you'd like?"
**VOICE_TOO_LONG** (>2 min): "That's a long voice note 😊 Could you tell me just the day and time you'd like to come?"

### 6.8 General
**MAIN_MENU** (GREETING by a known patient): "Hello {{name}} ji 😊 How can I help today?" Buttons: [Book appointment] [My appointments] [Queue status]
**OTHER_HELP**: "I can help you book, reschedule, cancel or check your turn in the queue. What would you like to do?" (+ menu buttons)
**CLINIC_INFO**: timings / address / fees from settings. E.g., "{{clinicName}} timings: {{sessionsText}}. Closed on {{closedDays}}. 📍 {{address}} {{mapsUrl}}"
**TALK_TO_STAFF**: "Sure. You can call the clinic at {{clinicPhone}} 📞 ({{sessionHours}}). I've also let the reception know you'd like a call back." (staff alert: "{{name}} ({{maskedPhone}}) asked for a call back.")
**THANKS_REPLY**: "You're welcome 🙏 Take care."
**RESUME_PROMPT**: "Coming back to your booking: {{pendingQuestion}}"
**RATE_LIMITED**: "I'm receiving a lot of messages at once. Please give me a moment 🙏"
**SYSTEM_ERROR**: "Sorry, something went wrong on my side. Please try again in a minute, or call {{clinicPhone}}."
**EXTRACTOR_DOWN** (fallback mode): menu buttons + "You can tap an option below."

### 6.9 Emergency (keyword matcher, in memory)
Trigger lists (EN / HI / Hinglish, configurable): chest pain, heart attack, can't breathe, breathing problem, unconscious, fainted, seizure, fits, heavy bleeding, accident, poison, suicide, stroke, सीने में दर्द, साँस नहीं, बेहोश, खून बह, दौरा, chest mein dard, saans nahi, behosh, khoon, accident ho gaya.
**EMERGENCY_REPLY**: "If this is an emergency, please call *108* or go to the nearest hospital right away.\nYou can also call the clinic directly: {{clinicPhone}}" Buttons: [Call clinic]
- Sent **before** any other processing of that message. Booking context is kept. Don't re-send within 10 min.

### 6.10 Clinic-initiated
**CANCELLED_BY_CLINIC** (template): "Sorry {{1}} ji, Doctor is unavailable on {{2}}. Your {{3}} appointment is cancelled. Reply to pick a new time, or call {{4}}." Buttons: [Pick new time] [Call clinic]
**CLINIC_CLOSED_TODAY** (in-window): same text, with today's queue.

## 7. Approved scenarios (acceptance scripts)
Each script is an end-to-end test in `apps/server/test/e2e/scenarios/*.test.ts`, run against MockWhatsApp + a mock extractor with fixed outputs. Dates assume "today" = Fri 10 Oct, clinic sessions 10:00–13:00 and 17:00–20:00, 20-min slots in the examples.

### S1: New patient booking
1. P: "Hi, I want to book appointment" → `WELCOME_CONSENT` [I agree, continue]
2. P: taps agree → `CONFIRM_NUMBER` [Use +91 98765 43210] [Different number]
3. P: taps use → `ASK_WHO` [For me] [Someone else]
4. P: "for my mother, Sunita" → profile created (relation MOTHER) → `ACK_PROFILE` + `ASK_WHEN`
5. P: "kal shaam 6 baje ke aas paas" → `OFFER_NEAR_SLOTS` [5:50 PM] [6:10 PM] [See all slots]
6. P: taps 6:10 PM → hold → `ASK_VISIT_TYPE`
7. P: taps New consultation → `BOOKING_CONFIRMED` (Sunita ji, Sat 11 Oct, 6:10 PM, Token A-4) [Reschedule] [Cancel]
**Asserts:** one Appointment (BOOKED, visitType NEW, slotKey unique). Reminders scheduled. ConsentRecord exists. No message text in the DB.

### S2: Returning patient + reminder + reschedule
1. P: "Hi, need appointment Monday morning" → "Welcome back, Ramesh ji. Is this for you or Sunita ji?" [For me] [Sunita ji] [Someone else]
2. P: For me → `OFFER_NEAR_SLOTS` (earliest Monday morning) [10:20 AM] [10:40 AM] [See all slots]
3. P: "10:40" → (visit type inferred or asked) → confirmed, Token A-3
4. (Sun 10:40) `reminder_24h` template [Confirm] [Reschedule] [Cancel]
5. P: Reschedule → `ASK_WHEN` → P: "same day but evening" → `OFFER_NEAR_SLOTS` [5:30 PM] [6:30 PM] [See all slots]
6. P: 6:30 PM → `RS_DONE` (Token A-5; 10:40 released)
**Asserts:** old slotKey freed. Old reminders cancelled and new ones scheduled. Token re-allocated in the new session's order.

### S3: Walk-in, quota full
1. P: "WALKIN DRS-4821" → `WALKIN_ASK_NAME` → P: "Anil Verma" → quota full → `WALKIN_CHECKING`
2. Staff WhatsApp: `staff_walkin_overflow` [Yes, adjust] [No] + dashboard popup
3. Staff: Yes → "Which time should I give? Type a time (e.g. 7:40 PM) or choose:" [End of queue] [{{suggested}}]
4. Staff: "7:50 PM" → patient: `WALKIN_ADJUSTED` (W-12, around 7:50 PM, 6 ahead)
5. Variant B: Staff: No → `WALKIN_DECLINED` with the next booking slots (+ call clinic line)
6. Variant C: no staff reply in 5 min → `WALKIN_TIMEOUT` → offers
**Asserts:** first staff response wins; the second staff member gets "Handled by …". A late reply after the timeout is rejected politely.

### S4: Queue status and alerts
1. P (W-07, waiting): "mera number kab aayega?" → `STATUS` (Now A-08, 3 ahead, about 20 min) in Hinglish
2. When ahead becomes 2 → `TURN_NEAR`
3. Doctor sends `LATE 15` → `DOCTOR_LATE` to everyone waiting or booked today, with recomputed ETAs
4. Staff taps Consultation completed (for the patient ahead) → W-07 becomes NEXT → `YOU_ARE_NEXT`
5. Next tap → W-07 IN_CONSULT → `YOUR_TURN`
**Asserts:** no duplicate alerts. ETA respects the delay offset. SSE events emitted.

### S5: Voice note, health details, emergency
1. P: [voice note 0:18, "kal subah appointment chahiye, bukhar hai teen din se"] → transcribed in memory → `VOICE_BOOKING_UNDERSTOOD` + health line + `OFFER_NEAR_SLOTS` [10:20 AM] [11:00 AM] [See all slots]
2. P: "I have fever since 3 days and my sugar is high, which one is better?" → `HEALTH_DETAILS_REDIRECT` (v2) + "The earliest slot tomorrow is 10:20 AM. Shall I book it?" [Book 10:20 AM] [See all slots]
3. P: [photo] → `MEDIA_REPORTS` (media not downloaded)
4. P: "papa ko chest pain ho raha hai abhi" → `EMERGENCY_REPLY` [Call clinic]
**Asserts (boundary):** the strings "bukhar", "fever", "sugar" and "chest pain" appear nowhere in the DB, the pg-boss tables or the logs. Image media was never fetched.

### S6: Slot taken at the same time + family same slot
1. Bot offered [5:50 PM] [6:10 PM]; another patient confirms 6:10 first; P taps 6:10 → `SLOT_RACE_LOST` [6:30 PM] [7:10 PM] [See all slots]
2. P: "no, I need 6 pm only" → `SLOT_RACE_DECLINED` [Try another day] [Call clinic]
3. P: Call clinic → `CALL_CLINIC` (+ contact card)
4. Later: P books 6:30 for himself, then "also book Aarav at 6:30 PM" → `SAME_SLOT_FAMILY` [Book 6:50 PM] [See all slots]
**Asserts:** the DB unique constraint prevents a double booking under a true concurrent insert (test with parallel transactions).

## 8. Staff and doctor WhatsApp commands
Sent from a whitelisted number to the clinic number. Case-insensitive; Hindi aliases in brackets.
| Command | Action | Reply |
|---|---|---|
| `NEXT` / `DONE` (agla) | Consultation completed (one-tap advance) | "✅ Done A-08. Now in consultation: W-07 Ramesh. Next: A-09 Sunita. Waiting: 6" |
| `START` | NEXT → IN_CONSULT | snapshot |
| `SKIP` / `NOSHOW` | NEXT → NO_SHOW, promote | snapshot |
| `STATUS` | | snapshot + counts |
| `ADD <name> [phone]` | walk-in by staff (bypasses quota) | "Added W-13 Anil, 7 ahead" |
| `LATE <min>` (late 20) | broadcast DOCTOR_LATE, set delay offset | "Informed 14 patients" |
| `PAUSE <min>` / `RESUME` | break banner + notice | |
| `CLOSE TODAY` | asks "Cancel remaining 9 appointments and 4 waiting? Reply YES" → bulk cancel | |
| `SUMMARY` | today's numbers | |
| `HELP` | list commands | |
| Overflow replies | buttons on `staff_walkin_overflow` | |

## Update 11 Oct 2026 (real-phone feedback)
- **Final confirmation:** after the visit type, the bot shows a summary (patient, date, time, visit, clinic) with **Confirm booking / Change time**. Nothing is booked before "Confirm booking". On the booking page, the confirm sheet plays the same role.
- **Booking page:** "book appointment" with no time named sends the **Choose date & time** button (`BOOK_LINK_BODY`). A patient can still type a time instead.
- **Short replies after a finished action** ("ok", "sure", "no") get `ACK_CLOSING`, not the menu.
- **Queue status without a booking today** starts "Queue status is visible for your bookings only". If there is a later booking, the reply shows it (`STATUS_FUTURE`).
- **Visit type:** the question explains the options, and the button is "Report review". The confirmation shows the visit type.

## Unfinished chats and changing course (11 Oct 2026)
- **30-minute reset:** a conversation left unfinished for 30 minutes starts fresh. The welcome message says so. On return the patient gets `SESSION_RESTARTED`, then their message is handled normally. Booking buttons from the old chat lead to the menu.
- **"Hi" mid-booking:** `WELCOME_BACK_MIDFLOW` with Continue / New booking / Something else. Mid-way through anything else, "hi" gets the main menu.
- **Stop:** "don't want to book", "nahi chahiye", "rehne do" or "cancel" (without a day), or "no" when asked for a day, gives `BOOKING_STOPPED` and releases any held slot. Phrases are matched in memory only.
- **Start over:** "start over", "restart", "shuru se" gives `STARTED_OVER` from any point.
- **New booking:** "I want to book" / "new booking" mid-booking starts that booking afresh.
- **A reply with no day:** `ASK_WHEN_RETRY` with Show free times / Stop booking, instead of repeating the question.

## Menu, language and session labels (11 Oct 2026, late)
- **Main menu:** the three buttons shown directly (Book appointment / My appointments / Queue status). WhatsApp allows 3 buttons per message, so until the patient has chosen a language, a small bubble *"🌐 Prefer another language?"* with **English / हिंदी / Hinglish** goes just above it.
- **Language:**
  - "Change language" offers English / हिंदी / Hinglish. The choice is locked: replies stay in that language whatever the patient types, until they change it.
  - Typed requests ("English please", "hindi mein baat karo", "reply in Hinglish") switch language directly. "Change language" with no language named shows the picker.
- **In-chat session buttons** show clinic hours: "Morning (10am–1pm)", "Evening (5:10–8pm)".
- **Booking page "Back to WhatsApp"** uses the WhatsApp app link (`whatsapp://send?phone=`), so iOS doesn't show its Messages / WhatsApp Business chooser. `wa.me` is the fallback.
- **Rescheduling** also confirms before anything moves: `RS_CONFIRM_ASK` shows From / To with **Confirm change / Change time**. "Change time" leaves the existing booking untouched. A booking where the visit type was already given also confirms first.

## Off-script messages (12 Oct 2026)
A real patient typed "Stupid", "Hold" and "Stop it now" at the number question and got the same question back each time.
Rules now, for every state:
- **Never the same message twice in a row in reply to typed text.** If the bot is about to repeat its last question word for
  word, it first says it didn't understand (`NOT_UNDERSTOOD`). Apologies, "take your time" and repeated menus rotate their wording.
- **Answer what was said first, then ask again:** rude → `RUDE_REPLY` (apology, what I can do, clinic phone); help → `HELP_REPLY`;
  a clinic question → the answer; hello → `HELLO_AGAIN`. At the number question, the reason is given (`NUMBER_WHY`).
- **"Hold on" keeps the place** (`WAIT_OK`, 30 minutes) and doesn't repeat the question.
- **Two misses in a row** mid-way → `STUCK_HELP` with [Continue] [Menu] [Call clinic]. At the agreement or number question the
  second miss adds the clinic phone (`GATE_CALL_ALT`). "No" to the agreement → `CONSENT_DECLINED`.
- **"Stop"** (unsubscribe) works from any state, including before consent, and drops whatever was in progress. "Stop it now" said in
  frustration is `RUDE`, not an unsubscribe.
- Declining data deletion now says `ERASE_KEPT` ("I haven't deleted anything"), not the cancellation text.
Tested by `apps/server/test/integration/offscript.test.ts`: 20 states × 16 off-script messages (English, Hinglish, Hindi), each
sent twice, plus live-AI personas u32–u36.

## Cancelling several appointments (13 Oct 2026)
- "Cancel" (typed, or the Cancel button on a confirmation or reminder) with **two or more** upcoming bookings lists all of them,
  numbered (`CX_PICK_MULTI`), as a WhatsApp list: one row per booking (date and time; name and token below) plus **All of these (N)**.
  Family bookings are included; a named person ("mummy ka") or day narrows the list.
- Pick one → `CX_CONFIRM` as before. Pick **All of these**, or type numbers ("1 and 3", "2,3", "first and third") or "all / both /
  dono / saare" → one confirmation for those (`CX_CONFIRM_MANY`: [Yes, cancel all] [Keep them]). "Cancel all my appointments" goes
  straight to that confirmation. A typed "dono" / "all" at the confirmation counts as yes; "nahi" keeps them.
- After a cancellation, if other bookings remain: `CX_DONE_MORE` lists them with [Cancel another] [No, that's all]. With one
  booking, cancelling works exactly as before.
- Typed numbers are matched in memory only; the state keeps the listed appointment IDs (`cxList`) and the chosen ones (`cxIds`).

## Privacy questions and complaints (14 Oct 2026)
"privacy", "privacy policy", "grievance", "complaint", "shikayat", "शिकायत" (from any state, even before consent) → `GRIEVANCE_INFO`:
the Grievance Officer's email (Incolo Systems, `GRIEVANCE_EMAIL`), the clinic's phone, the privacy policy link, "my data" /
"delete my data", and the Data Protection Board of India. Mid-booking, the pending question follows. "delete my data for privacy"
still goes to deletion.

## Declining and leaving (15 Oct 2026)
Before this, "I don't want to book", "no thanks", "bye", "close this chat", "wrong number"… got the menu again, the next
booking question, "Sorry, I can't help with that", or even an unsubscribe. Now, from any state (intent `END`, plus in-memory
phrases in EN / Hinglish / Hindi):

| Where | Reply (no buttons) |
|---|---|
| Before consent | `CLOSED_NO_CONSENT`: nothing has been saved |
| Mid-booking (hold released) or rescheduling | `BOOKING_STOPPED`: stopped, nothing booked |
| Menu / after a booking / number question | `CHAT_CLOSED` (two wordings) |
| Confirming a cancellation | `CX_KEPT` / `CX_KEPT_MANY` (appointments kept) |
| Confirming data deletion | `ERASE_KEPT` |
| "wrong number", "by mistake" | `WRONG_NUMBER` (also as a first message: no consent request) |
| "I'll call the clinic" | `CALL_CLINIC` + contact card (no call-back request raised) |

- Not an end when the message also asks for something: "not Monday, book Tuesday evening", "not for me, for my mother".
- "I don't want my appointment" is a cancellation (asks to confirm). A bare "stop" is still an unsubscribe.
- Bare "no": after the menu → `CHAT_CLOSED`; to who / name / visit type / day → `BOOKING_STOPPED`; to offered times or the
  final confirmation → `OTHER_TIMES_OR_STOP` [Show free times] [Stop booking]; to "use this number?" → asks for the number.
- "ok" after the menu → `MENU_NUDGE` (no repeated menu). "ok"/"thanks" after any close → `ACK_CLOSING`.
Tested by `declines.test.ts` (14 states × 26 messages, then "ok"), live-AI personas u39–u44, and the live check.
