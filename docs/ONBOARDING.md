# Real customer onboarding (kept separate from demos)

A demo needs only a name and public details (Demo Studio). A **live clinic** needs the fuller set below. This is a checklist for the onboarding call, done once the customer signs.

## 1. Legal and data protection
- [ ] Customer agreement + **Data Processing Agreement** (the clinic is the Data Fiduciary and Incolo is the processor). Lawyer review of the privacy notice and DPA happens at this point.
- [ ] Clinic legal name, GST (if registered), registration or establishment certificate (for Meta business verification)
- [ ] Grievance officer (name, email, phone), shown to patients on "privacy"
- [ ] Privacy-notice version accepted (`settings.noticeVersion`), with the clinic's name in the notice

## 2. Clinic profile
- [ ] Clinic display name, doctor display name, qualification line
- [ ] Short address (for confirmations), full address, Google Maps link
- [ ] Public clinic phone (shown in "Call clinic" and emergency replies)
- [ ] Fees text (and booking fee yes/no, which is Phase 2)

## 3. Schedule rules
- [ ] Sessions per weekday: start, end, **slot length** (10, 15 or 20 min), **walk-in quota**
- [ ] Booking window (days ahead), cut-off (minutes before), late grace, no-show grace
- [ ] Holidays and leave for the next 3 months
- [ ] Token style: A-/W- series, or plain numbers. Slot-index or sequential appointment tokens
- [ ] Walk-in overflow timeout, and the "turn near" alert threshold

## 4. People
- [ ] Doctor's WhatsApp number (admin; can run the queue by WhatsApp commands)
- [ ] Staff names and WhatsApp numbers (dashboard login by OTP), plus who's on duty for walk-in overflow

## 5. WhatsApp number (docs/META_ONBOARDING.md, path C or D1)
- [ ] Own number (coexistence or new SIM), or an Incolo pool number
- [ ] Meta business portfolio + payment method (customer pays Meta)
- [ ] `npm run meta -- register / subscribe / templates / flow / check` all green

## 6. Reception setup
- [ ] Print the **walk-in QR** poster (Settings → Walk-in QR & TV; it changes daily, so use a screen or reprint)
- [ ] TV or monitor showing the display link, in kiosk mode
- [ ] 15-minute staff walkthrough: board, overflow pop-up, WhatsApp commands
- [ ] Soft launch: one session with the doctor watching

## 7. Go live
- [ ] Clinic created as a **live** (non-demo) clinic. Demo Studio stays separate.
- [ ] Backups confirmed, monitoring on (docs/DEPLOYMENT.md §7–9)
- [ ] First-week check-in: no-shows, wait times, any messages the bot didn't understand (the logs show intents only)
