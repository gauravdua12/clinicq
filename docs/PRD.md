# PRD: ClinicQ

## 1. Problem and goal
A solo or small-staff clinic runs on a paper register, phone calls and a crowded waiting room. Patients don't know when their turn will come. Walk-ins and booked patients get mixed up. No-shows waste slots.
**ClinicQ** is a WhatsApp assistant that feels like a friendly receptionist. It books appointments in seconds, manages walk-ins, runs one daily token queue and keeps everyone informed, while storing **logistics only**.

## 2. Personas
| ID | Persona | Channel |
|---|---|---|
| P | Patient or guardian | WhatsApp |
| D | Doctor (owner) | WhatsApp commands + dashboard (mobile) |
| S | Staff / receptionist (0–3 people) | Dashboard + WhatsApp alerts |
| T | Waiting-room TV | Display page |

## 3. Success metrics (first 60 days)
- Median time to book on WhatsApp is under 60 s, measured from first message to confirmation.
- At least 90% of bookings complete without a human.
- No-show rate falls by at least 30% from the clinic's baseline (thanks to reminders).
- Zero medical data persisted: the data-boundary suite passes and the monthly audit query finds nothing.

## 4. Scope
**MVP:** modules M1–M9 below. **Phase 2:** M10 (booking fee), M11 (follow-ups), M12 (reports + daily summary), plus a regional language. **Out of scope:** consultation or triage, prescriptions, EMR, telemedicine, marketing, multiple doctors (designed for, not built).

---

## 5. User stories and acceptance criteria
IDs are referenced in `TASKS.md` and the tests.

### M1: Clinic setup (D)
- **CS-01** As the doctor, I set clinic name, doctor display name, qualification line, address, Maps link and clinic phone.
- **CS-02** I define weekly sessions (e.g., Mon–Sat 10:00–13:00 and 17:00–20:00), each with a slot length (minutes) and a walk-in quota.
  - AC: sessions on the same day can't overlap. Slot length must divide the session or the last partial slot is dropped.
- **CS-03** I set the booking window (days ahead, default 7), booking cut-off (minutes before the slot, default 60), late grace (default 15 min) and no-show grace (default 30 min after session end).
- **CS-04** I add closures (full day or a session) and leave dates.
  - AC: adding a closure that has bookings opens a confirmation showing the count. On confirm, every affected patient gets `cancelled_by_clinic` with reschedule options (see CONVERSATION_GUIDE §6.10).
- **CS-05** I add staff (name, WhatsApp number, role STAFF). The doctor's own number has role DOCTOR.
- **CS-06** Settings for token series (A/W prefixes or a single series), TV privacy (token only, or token + first name), "near" window for smart suggest (default ±60 min), walk-in overflow timeout (default 5 min), turn-near alert (default 2 ahead).

### M2: Identity, consent, number confirmation (P)
- **ID-01** On first contact, the bot sends the welcome + information disclaimer + short privacy notice with link and [I agree].
  - AC: nothing except the `PatientAccount` phone hash and a pending-consent marker is stored before agreement. If the patient types booking intent before agreeing, the bot remembers it in the conversation state (structured fields only) and resumes after consent.
- **ID-02** After consent, the bot shows the detected WhatsApp number: "I'll book this with your number +91 98765 43210. Is that okay?" with [Use +91 98765 43210] [Different number].
  - AC: *Different number* asks for a 10-digit Indian mobile, validates it, and stores it as `PatientProfile.contactPhone`. Messages still go to the chatting WhatsApp number.
  - AC: number confirmation is asked once per account (it can be changed with "change my number").
- **ID-03** The bot uses the WhatsApp profile name as the suggested name ("Is this booking for you, Ramesh?").
- **ID-04** Family profiles: "for my mother", "mummy ke liye", "for my son Aarav" creates or selects a profile under the account. The relation label is optional; name is required; year of birth and gender are optional.
  - AC: up to 8 profiles per account. Fuzzy matching on existing names: "mummy" matches the profile with relation MOTHER.
- **ID-05** Patient rights: "show my data" → sends a summary of stored fields. "delete my data" → confirms, then erases (see DATA_POLICY §6). "stop" → opts out of all non-essential messages.

### M3: Booking (P)
- **BK-01** The patient asks for an appointment in natural language (EN/HI/Hinglish, text or voice). The system extracts the date and time preference and who it's for.
- **BK-02** **Smart suggest:** if 1 or more free slots exist on the requested day within the near window of the requested time, show the **2 nearest** as reply buttons plus [See all slots].
  - AC: if only a day is given ("tomorrow"), with no time, suggest the 2 earliest free slots in the next session that's still bookable that day. If only a part of day is given ("evening"), use the session that matches it.
  - AC: the patient can type a time instead ("6:30 chalega?"). If it's free, book it; if not, re-suggest.
- **BK-03** **Booking form (WhatsApp Flow):** if no free slot is near the request, or the patient taps *See all slots*, send the Flow: date chips (next N days, closed days disabled) → slot list for the chosen date grouped Morning/Evening (taken slots hidden or disabled) → Confirm.
  - AC: slot data comes live from the Flow data endpoint. On confirm the server re-validates, and if the slot was taken the BK-07 path applies.
- **BK-04** **Fallback list picker:** if the Flow can't be sent or opened (API error, or the patient replies "can't open"), send an interactive list with up to 10 slots grouped by session.
- **BK-05** Visit type: ask "New consultation / Follow-up / Show reports" (or infer it from text such as "follow up"). Stored as an enum only.
- **BK-06** Confirmation message: profile name, day, date, time, token number, clinic address + Maps link, [Reschedule] [Cancel].
  - AC: the appointment token (`A-n`) is allocated at confirmation, in slot order for that session (see QUEUE_ENGINE §3.2).
- **BK-07** **Slot race:** if the chosen slot was taken during the flow, apologise and show the 2 nearest alternatives plus [See all slots]. If the patient declines ("no", "I need 6 only"), offer [Try another day] [Call clinic]. *Call clinic* sends the clinic number with a tap-to-call link and session hours.
- **BK-08** **One booking per slot, always.** A second family member can't take the same slot. The bot offers the next adjacent free slot ("Shall I book Aarav right after, at 6:50 PM?").
- **BK-09** Booking rules: no booking inside the cut-off, beyond the window, on closures or in past slots. At most 2 active future bookings per profile (configurable).
- **BK-10** Reschedule and cancel in plain words, or from buttons. Reschedule keeps the profile and visit type and offers new slots (smart suggest → Flow). Cancel asks for confirmation and releases the slot immediately.
- **BK-11** Reminders: T-24h (`reminder_24h` with Confirm / Reschedule / Cancel) and on the day, 2 hours before (`reminder_same_day` with the doctor's running status + Maps link). If the booking was made less than 24 hours ahead, skip the T-24h reminder.
- **BK-12** **Check-in:** the patient says "I've reached" / "pahunch gaya", or staff taps *Arrived*. This creates a QueueEntry in WAITING (see QUEUE_ENGINE). If the patient arrives more than 60 minutes early, the bot says "You're early, I'll add you closer to your time" and the system auto-checks them in 30 minutes before the slot. The window is configurable.
- **BK-13** **No-show:** appointments still BOOKED (never arrived) at session end + grace become NO_SHOW, and the patient gets a gentle message with a rebook option.

### M4: Walk-ins (P, S)
- **WI-01** A QR code at reception encodes `https://wa.me/<number>?text=WALKIN%20<CLINICCODE>-<DAILYCODE>`. The daily code rotates at 00:00 IST. The dashboard and TV page show today's QR for printing or display.
  - AC: a wrong or expired code gets "Please scan the QR code at the reception desk to join today's queue 😊".
- **WI-02** After number confirmation and a name (or profile choice), if the session's walk-in quota has room, issue a `W-n` token immediately, enter WAITING, and reply with token, position and ETA.
- **WI-03** **Quota full → staff escalation:** create a `WalkinOverflowRequest`, tell the patient "checking with reception, one moment", and notify all on-duty staff (WhatsApp `staff_walkin_overflow` with [Yes, adjust] [No], plus a dashboard pop-up).
  - **Yes** → staff is asked "Which time should I give?" Staff types a time or taps [End of queue]. The token is issued with that expected time, and the patient is informed.
  - **No** → the patient is offered the next available booking slots (smart suggest from now, then Flow) plus [Call clinic].
  - **Timeout** (default 5 min, no staff reply) → the No path, with the copy "Reception is busy right now…". A late staff reply after the timeout gets "Already handled (patient offered booking slots)".
  - AC: the first staff reply wins. The others get "Handled by <name>".
- **WI-04** Staff adds a walk-in from the dashboard: name (required), WhatsApp number (optional). Without a number, the token is announced verbally or on screen only.
- **WI-05** If the walk-in quota is 0 for a session, every walk-in goes through WI-03.

### M5: Queue engine and board (S, D)
- **QU-01** Queue states: **WAITING → NEXT → IN_CONSULT → COMPLETED**, plus **NO_SHOW** and **CANCELLED**. See QUEUE_ENGINE for the transition table.
- **QU-02** Board columns: Waiting (ordered), Next (one), In consultation (one). The primary button is **✔ Consultation completed**: it completes IN_CONSULT, moves NEXT → IN_CONSULT, and promotes the top of Waiting → NEXT. All in one tap.
  - AC: if In consultation is empty and Next is set, the primary button reads **Start consultation** (NEXT → IN_CONSULT).
  - AC: if Next is empty and Waiting isn't, the system auto-promotes the top Waiting patient.
- **QU-03** Secondary actions: No-show (on NEXT, which promotes the following patient), Cancel, Move up / Move down (in Waiting), Re-add (a NO_SHOW patient who returns joins the end of Waiting), Add walk-in, Mark arrived (from today's appointments).
- **QU-04** The ordering rule (default) is described in QUEUE_ENGINE §4 and is configurable.
- **QU-05** Every action is audit-logged (who, what, when) and pushed via SSE to all open dashboards and the TV within 1 s.
- **QU-06** Concurrent actions: last write wins, guarded by the entry's `version` (optimistic lock). A stale action shows "Board updated, please retry".

### M6: Live tracking and alerts (P)
- **TR-01** The patient asks about status in any words → "Now with Doctor: A-08. You: W-07, 3 ahead, about 20 min."
- **TR-02** Auto-alert when the patient becomes `turnNearThreshold` ahead (default 2) → `turn_near`.
- **TR-03** On NEXT → "you're next, please be ready". On IN_CONSULT → "It's your turn, please proceed to the cabin." Optional; if Next and In consultation follow within 60 s, send only the second.
- **TR-04** Doctor or staff broadcasts: `LATE <min>` → `doctor_running_late` to everyone booked or waiting today (recomputed ETA). `PAUSE <min>` → break notice to Waiting only. `CLOSE TODAY` → confirm, then bulk-cancel the rest of today (CS-04 flow).
- **TR-05** Inside the 24-hour customer-service window use free-form session messages. Outside it, use the approved template. The `packages/wa` sender picks automatically.

### M7: Doctor WhatsApp commands (D, S)
- **DC-01** Whitelisted staff and doctor numbers can send commands to the clinic number (case-insensitive, Hindi aliases allowed): `NEXT`/`DONE` (= Consultation completed), `START`, `NOSHOW`, `SKIP` (= no-show for NEXT), `STATUS` (queue snapshot), `LATE 20`, `PAUSE 15`, `RESUME`, `CLOSE TODAY`, `ADD <name>` (walk-in), `SUMMARY`, `HELP`.
- **DC-02** A staff number that sends a non-command message gets the help list. Staff are never treated as patients, unless they send `PATIENT MODE` (to test).

### M8: Waiting-room display (T)
- **TV-01** `/display?key=<displayKey>`: full screen, large type. Shows **In consultation**, **Next**, the next 5 **Waiting**, today's walk-in QR (toggle), and a doctor status banner (running late, on break).
- **TV-02** Optional voice call-out (browser SpeechSynthesis, `hi-IN` / `en-IN`) on NEXT: "Token W-07, please be ready" / "Token W-07, please proceed".
- **TV-03** Privacy setting: token only, or token + first name.

### M9: Dashboard basics (D, S)
- **DB-01** Login with WhatsApp number → OTP via the `staff_login_otp` template (6 digits, 5 min, 5 attempts). Session cookie lasts 12 hours (httpOnly, sameSite=strict).
- **DB-02** Tabs: **Queue** (board), **Appointments** (today plus next 7 days; check-in, cancel, reschedule-on-behalf, block slot), **Settings** (M1), **Reports** (Phase 2).
- **DB-03** Staff can book on behalf of a phone caller: name, phone, slot. The patient gets the confirmation template.
- **DB-04** Mobile-first layout; works on a 360 px-wide phone.

### M10: Booking fee (Phase 2, toggle, off by default)
- **PF-01** When enabled, after slot selection the bot sends a Razorpay or Cashfree UPI payment link. The slot is held for `paymentHoldMinutes` (default 10). The booking is confirmed on the payment webhook.
- **PF-02** Cancellation more than X hours before → automatic refund per the clinic's policy. The policy text is shown before payment.
- **PF-03** Only order ID, amount, status and refund status are stored.

### M11: Follow-ups (Phase 2)
- **FU-01** After Consultation completed, the board shows [Follow-up: 7d / 15d / 30d / custom] for 10 s, then fades.
- **FU-02** `followUp.remindDaysBefore` (default 2) days before the due date, 10:00: `followup_due` with [Book now] → booking pre-set to that patient, that date and visit type Follow-up. No reminder if they've already booked; a booking from a week before the due date onwards fulfils it. Staff can also set it from a visit in Appointments, and see/cancel them in Appointments → Follow-ups & payments.

### M11b: Payment reminders (built Oct 2026)
- **PR-01** Staff enter an amount due for a visit (queue board after the consultation, or Appointments). Amount and date only, never what it was for. Needs the clinic's UPI ID (Settings → Clinic).
- **PR-02** The patient gets `payment_due` (utility) with a "Pay now" button to a pay page: amount, UPI app link with the amount filled in, QR code, "or pay at the clinic". The page shows no patient details. Q-Incolo never handles the money.
- **PR-03** Reminders every `remindEveryDays` (3) at 11:00, at most `maxReminders` (2) after the first message; staff can "Remind now" (once per 12 h). Patients opted out of reminders get none.
- **PR-04** The patient replying "paid" / "pay kar diya" / "भुगतान कर दिया" stops the reminders and alerts the staff ("says they've paid"); staff "Mark paid" sends `payment_received`.

### M12: Reports and daily summary (Phase 2)
- **RP-01** The daily summary goes to the doctor's WhatsApp 15 min after the last session ends: booked, walk-ins, completed, no-shows, cancellations, average wait, average consult time, fees collected.
- **RP-02** Reports tab: footfall by day, peak hours heatmap, no-show rate, average wait, booking-vs-walk-in mix. **No clinical data, ever.**

## 6. Non-functional requirements
- **Response time:** bot reply within 3 s (p95) for text and within 8 s for voice notes.
- **Availability:** a single VM is acceptable. Restarts must not lose jobs (pg-boss persists them).
- **Scale target:** 150 patients/day, 5 concurrent dashboard users, 30 messages/min peak.
- **Languages:** EN, HI, Hinglish at launch. A regional language is added by dropping in a copy file plus templates.
- **Accessibility:** the dashboard meets WCAG AA contrast. The TV page is readable at 5 m.
- **Security and privacy:** see DATA_POLICY and ARCHITECTURE §Security.
