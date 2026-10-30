# Getting WhatsApp numbers live (demo and customers)

This guide covers four things, using the same steps throughout:
- **(A)** Incolo's one-time setup with Meta
- **(B)** the demo number **+91 99203 23832**
- **(C)** a customer's own number
- **(D)** numbers that Incolo pre-onboards and hands to customers

Commands assume the ClinicQ server is reachable at `https://q.incolo.si` (no base path).

Sources: Meta's [Embedded Signup v4](https://developers.facebook.com/blog/post/2026/05/14/embedded-signup-v4/), [messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits), and [phone-number migration](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/support/migrating-phone-numbers-among-solution-partners-via-embedded-signup) docs. [Coexistence](https://chakrahq.com/article/whatsapp-coexistence-live-eu-uk-europe-whatsapp-business-for-api-live/) has been available in India since June 2026.

---

## A. One-time setup for Incolo (about 1 day of work, plus Meta review time)
| # | Step | Where | Notes |
|---|---|---|---|
| A1 | **Meta Business portfolio "Incolo"** | business.facebook.com | Use the legal entity name exactly as it appears on GST and incorporation documents. Add 2 admins |
| A2 | **Business verification** | Security Centre → Start verification | Upload GST certificate / CoI / utility bill. Website and email must be on the same domain (incolo.si). This raises the messaging limit from **250/day to 2,000/day** right away |
| A3 | **Developer app** "ClinicQ by Incolo" (type *Business*) → add the **WhatsApp** product | developers.facebook.com | Use a **separate app from watsappai**: an app has one webhook URL, so a separate app keeps the two products' traffic apart |
| A4 | **Webhook**: callback `https://q.incolo.si/webhook`, verify token = `META_VERIFY_TOKEN`. Subscribe the **messages** field | App → WhatsApp → Configuration | The server must be live first. Meta calls GET /webhook to verify |
| A5 | **System user** (admin) → generate a **permanent token** with `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management` | Business settings → Users → System users | Store it as `WA_ACCESS_TOKEN` on the server only |
| A6 | **App Secret** → `META_APP_SECRET` | App settings → Basic | Used to verify webhook signatures |
| A7 | **Become a Tech Provider** and set up **Embedded Signup v4** (Facebook Login for Business configuration) | App dashboard → WhatsApp → *Become a Tech Provider* | Needed to onboard *customers'* own numbers in about 10 minutes (C). App review for advanced access. Plan for 1–2 weeks |
| A8 | **Payment method** on Incolo's WhatsApp account | WhatsApp Manager → Payment settings | Pays for messages on numbers in Incolo's own WABA (demo and option D2) |
| A9 | **App mode → Live** and privacy policy URL `https://q.incolo.si/privacy` | App settings | |

## B. The demo number +91 99203 23832 (about 1 hour)
1. **Decide how the number is used today.**
   - If it's on the regular WhatsApp app (personal), back up the chats, then use *Settings → Account → Delete account* on that phone. A number can't be on the API and the personal app at the same time.
   - If it's on the **WhatsApp Business app** and you want to keep using the app too, use **coexistence**: onboard through Embedded Signup and choose *Connect your existing WhatsApp Business app*. In the Business app you scan a QR code. Chat history (6 months) and contacts carry over.
2. WhatsApp Manager → **Phone numbers → Add phone number**.
   - **Display name:** "ClinicQ Demo" or "ClinicQ by Incolo". The name must relate to the business that owns the WABA (Incolo). A clinic's name isn't allowed here.
   - Category: *Medical & health*. Description: "Appointment and queue assistant demo".
3. **Verify** with the 6-digit code by SMS or voice call. The SIM must be able to receive it.
4. Copy the **Phone number ID** and **WhatsApp Business Account ID** into the server env (`WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`). Set `WA_MODE=cloud` and `WA_DISPLAY_NUMBER=919920323832`.
5. Run on the server:
   ```bash
   npm run meta -- register --pin <choose 6 digits>     # turns the number on for Cloud API (keep the PIN safe)
   npm run meta -- subscribe                            # links the WABA's events to this app
   npm run meta -- templates                            # 12 templates × EN/HI + login OTP (utility ones approve in minutes)
   npm run flow:keys -- /etc/clinicq/flow && npm run meta -- flow --public-key /etc/clinicq/flow/public.pem
   npm run meta -- check                                # name status, quality, template approvals
   npm run meta -- send-test --to 91XXXXXXXXXX          # hello_world to your own phone
   ```
6. Set `WA_FLOW_ID_BOOKING` (printed by the `flow` step) and `FLOW_PRIVATE_KEY_PATH`, then restart.
7. **Smoke test from a phone:** send "Hi" → consent → number → book. Then send a real **voice note** and confirm it is understood.
8. In **Demo Studio**, add `DEMO_PRESENTER_PHONES` (the presenter's own WhatsApp number). It becomes the demo clinic's doctor and can send NEXT, LATE 15 and so on.

**During a demo**, patients see the display name "ClinicQ Demo", and the bot's messages use the demo clinic's name ("Sanjeevani Child Care Clinic"). One demo is active at a time. Switch the active demo in Demo Studio before each meeting.

## C. A customer's own number (recommended for live clinics; about 15 minutes with the doctor) — built Oct 2026
Uses **Embedded Signup**: the customer owns the WABA (in their own Meta portfolio), Incolo gets access as Tech Provider, and the customer pays Meta directly. Facebook Login for Business configuration: **1454298736672568** (WhatsApp Cloud API only; env `META_ES_CONFIG_ID`).
1. **Incolo admin:** the **Customer clinics** page (menu; Incolo admins only, also a phone tab) → add the clinic (name, doctor's name and WhatsApp number, clinic phone, short address). It starts with Mon–Sat 10–1 and 5–8 sessions.
2. **Doctor:** signs in at https://q.incolo.si/login with their WhatsApp number, checks Settings → Clinic and Sessions, then Settings → **WhatsApp** → **Connect WhatsApp** (or *I use the WhatsApp Business app on this number* for coexistence).
3. In Meta's pop-up the doctor logs in with Facebook → creates or picks their **business portfolio** → adds and verifies the **clinic number** (SMS or call). **Display name** = the clinic's name.
4. Q-Incolo then, by itself: exchanges the code for the clinic's token (encrypted), checks the number, subscribes the account to our webhook, registers the number (two-step PIN kept encrypted), and submits all templates (EN + HI) for approval. Settings → WhatsApp shows display-name status, quality, messaging limit and template approvals (*Check status*, *Send missing templates*, *Disconnect*).
5. The doctor adds a **payment method** in WhatsApp Manager. Utility messages cost about ₹0.145 each; replies within 24 hours are free.
6. **Business verification** of the clinic raises the limit to 2,000 business-initiated messages a day. Until then the limit is 250 a day, which is enough for about 60 patients a day.
- Until the number is connected, the doctor's login code comes from the shared Q-Incolo number; afterwards from the clinic's own number (or still from the shared number, when the doctor signs in with the clinic's own number).

## D. Numbers Incolo provides, pre-onboarded for speed
Use this when the doctor doesn't want to use their own number, or wants to start the same day. There are two models:

**D1 (recommended): Incolo-owned SIM, attached to the customer's WABA at onboarding**
- **Ahead of time:** buy SIMs or virtual numbers, never put them on WhatsApp, and keep them able to receive OTPs (a phone at the Incolo office or a virtual-number provider with SMS forwarding). Keep a register of number → status.
- **At onboarding:** run Embedded Signup as in C, and *Incolo* receives the OTP for the chosen pool number. The display name is the clinic's name, and the customer pays Meta. Templates and Flow are created by the script in about 5 minutes.
- **If the customer leaves:** they can keep the number (porting via Meta *migration*: turn off two-step verification, then move it to their new WABA), or Incolo takes it back. Write this into the contract.

**D2: number stays in Incolo's own WABA ("ClinicQ by Incolo")**
- This is the quickest option (number ready in minutes, Incolo pays Meta and re-bills), but the **display name must relate to Incolo**, for example "ClinicQ · Dr Sharma Clinic". It may be rejected or appear generic.
- All clinics also share Incolo's messaging limit and quality rating.
- Use D2 only for trials and pilots, then move to D1 or C (migration keeps the number, quality rating and templates).

> **Recommendation:** use **B** for demos. For paying customers use **C** if they have a suitable number (coexistence makes this painless), otherwise **D1**. Pre-onboarding means keeping a small pool of D1 numbers verified-ready, plus the automated template and Flow setup, so a new clinic is live within the meeting.

## E. Technical checklist per number (automated by `npm run meta`)
- [ ] Number registered (`register`), and the two-step PIN recorded in the password manager
- [ ] WABA subscribed to the app (`subscribe`)
- [ ] Display name **approved**, and quality **GREEN** (`check`)
- [ ] Templates **APPROVED** in EN and HI (`check`)
- [ ] Flow public key uploaded, Flow **PUBLISHED**, `WA_FLOW_ID_BOOKING` set
- [ ] Webhook delivers: "Hi" from a phone gets the welcome reply
- [ ] Voice note from a phone is transcribed (Voxtral)
- [ ] Payment method present on the WABA

## F. Costs and limits (2026)
- **Messages:** utility template ₹0.145, authentication ₹0.145, replies within 24 hours free, marketing not used.
- **Messaging limit:** 250 business-initiated per day for a new portfolio, 2,000 after business verification, then automatic increases to 10k, 100k and unlimited while quality stays high. Limits apply per business portfolio.
- **Throughput:** about 80 messages per second per number, far more than a clinic needs.
