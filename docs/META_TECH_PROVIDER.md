# Becoming an independent WhatsApp Tech Provider (Meta app review pack)

Everything Meta asks for to approve Incolo Systems' app (Q-Incolo) as an independent Tech Provider, with the values to paste.
Order matters: business verification → app settings → App Review → Access Verification → Live mode → Embedded Signup.

## 1. Business verification (Meta Business Suite → Security Centre)
- Business portfolio: **Incolo Systems** (ID 1798163907990912). Turn on two-factor authentication for all admins first.
- Upload the company's registration documents; the legal name and address must match them exactly.
- Verify a domain you control (DNS TXT record or meta tag) and use an email on that domain (e.g. customercare@incolosystems.com).

## 2. App settings (developers.facebook.com → App 2655971144875702 → App settings → Basic)
| Field | Value |
|---|---|
| App name | Q-Incolo (must match the policy pages; no "WhatsApp" or other Meta trademarks) |
| App icon (1024×1024) | `brand/q-incolo-app-icon-1024.png` (transparent notches) or `brand/q-incolo-app-icon-1024-opaque.png` |
| Contact email | customercare@incolosystems.com |
| Privacy Policy URL | https://q.incolo.si/privacy |
| Terms of Service URL | https://q.incolo.si/terms |
| User data deletion | "Data deletion instructions URL": https://q.incolo.si/data-deletion |
| Category | **Messaging** |
| App domains | q.incolo.si (plus the business website domain) |
| App type / use case | Business / Other, with the WhatsApp product added |

The three policy pages must stay reachable at all times (Meta's crawler re-checks them). See "Hosting" below.

## 3. App Review (App Review → Permissions and features)
Request **advanced access** for `whatsapp_business_messaging` and `whatsapp_business_management`.

**Screencast 1, `whatsapp_business_messaging`** (English UI, with captions):
1. Log in to the Q-Incolo dashboard (https://q.incolo.si) as clinic staff.
2. Appointments → pick a free slot → **Book** → enter a test patient (name + a WhatsApp number you hold) → **Book**.
3. Show the phone: the booking confirmation arrives on WhatsApp from the clinic number.
4. On the phone, reply "status"; show Q-Incolo's reply arriving, and the queue board updating.

**Screencast 2, `whatsapp_business_management`**: create a message template.
1. WhatsApp Manager → Message templates → Create template → Utility → name `appointment_confirmed`.
2. Paste the body from `packages/wa/src/templateText.ts`, add the sample values, submit; show it in the list as "In review/Approved".
(Alternatively record `npm run meta -- templates` submitting Q-Incolo's templates through the API and the result in WhatsApp Manager.)

**Allowed usage answers (paste):**
- Business Description: *Incolo Systems builds Q-Incolo, a WhatsApp appointment and token-queue assistant that doctors' clinics in India use on their own WhatsApp Business numbers.*
- `whatsapp_business_messaging`: *Q-Incolo uses whatsapp_business_messaging to send and receive WhatsApp messages for each clinic that connects its own WhatsApp Business Account. When a patient messages the clinic, Q-Incolo replies so they can book, reschedule or cancel an appointment and check their place in the queue. It also sends utility messages the patient has set in motion: booking confirmations, appointment reminders and "your turn is near" updates, and sends clinic staff their login codes and walk-in alerts. Q-Incolo sends no marketing or promotional messages. Message text, voice notes and media are only processed to understand the booking request and are never stored.*
- `whatsapp_business_management`: *Q-Incolo uses whatsapp_business_management to manage the WhatsApp Business Accounts that clinics connect to it: reading the phone number's details (display number, verified name, quality rating), subscribing our app to the account's webhooks, and creating and checking the clinic's utility message templates (booking confirmation, appointment reminders, queue updates) in English and Hindi, and the authentication template for staff login codes. We use this access only to run Q-Incolo for that clinic.*
- `public_profile`: *Q-Incolo uses public_profile only through Facebook Login for Business, when a clinic administrator connects their WhatsApp Business Account with Embedded Signup. We use the person's name and ID only to record who connected the clinic's account, and for nothing else.*

**Reviewer notes (paste):**
> We are applying to become a WhatsApp Tech Provider. Q-Incolo is an appointment and token-queue assistant for doctors' clinics in India. Each clinic connects its own WhatsApp Business Account through Embedded Signup. Q-Incolo answers patients who message the clinic (booking, reminders, queue status) and sends only utility messages the patient or clinic set in motion; no marketing. We use `whatsapp_business_messaging` to send and receive these messages and `whatsapp_business_management` to read the clinic's phone number details and create its utility message templates. Patients' message text, voice notes and media are never stored; only appointment logistics are kept. Test login: [give a staff test number and the OTP instructions].

**Data handling questions:** answer from the Privacy Policy. Data processors: Amazon Web Services (India). No data is sold or shared with advertisers. Data deletion: on request or within 30 days of disconnection. Security: HTTPS, AES-256-GCM encryption at rest, role-based access, Meta signature checks on webhooks.

## 4. Access Verification (after App Review)
Meta asks how the business uses other businesses' data. Suggested answer:
> Incolo Systems provides Q-Incolo, software that clinics use to manage appointments and patient queues on their own WhatsApp Business numbers. With each clinic's permission (given in Embedded Signup), we use its WhatsApp Business Account to send and receive appointment messages for that clinic and to manage its utility templates. We use the data only to provide the service to that clinic, store it in India, never sell it or use it for advertising, and delete it when the clinic disconnects.

## 5. Live mode and Facebook Login for Business
**Status (30 Oct 2026):** App Review approved (whatsapp_business_messaging, whatsapp_business_management, public_profile). Configuration **1454298736672568** "Q-Incolo Signup" (WhatsApp Embedded Signup, WhatsApp Cloud API only, system-user token, never expires, the 5 WhatsApp tasks). Delete the earlier configuration 2536031243541221 (it also asked for Marketing Messages and ads/Pages permissions). Still to do: Access Verification (if not verified) and Publish (Live).
- Switch App Mode to **Live** (needs the contact email, privacy and terms URLs).
- Facebook Login for Business → create a configuration for **WhatsApp Embedded Signup** (version 4): token expiry **Never**; assets: WhatsApp accounts with MANAGE, MANAGE_TEMPLATES, MESSAGING, VIEW_PHONE_ASSETS, VIEW_TEMPLATES.
- Login settings: Client OAuth, Web OAuth, Enforce HTTPS, Strict mode, JavaScript SDK login on; add the Q-Incolo domain to Allowed Domains and Valid OAuth Redirect URIs.
- Embedded Signup v2/v3 are retired on 15 Oct 2026: build on v4 only.

## Hosting the policy pages
They are served by Q-Incolo at q.incolo.si. While the server is switched to the watsappai demo (`demo-switch watsappai`), q.incolo.si
is down, and Meta's crawler could flag the app. Before submitting: keep Q-Incolo always on, or also publish the three pages on the
company website and use those URLs.

## What still needs a person
- Business verification documents, domain verification, and recording the screencasts.
- Grievance Officer: Gaurav Dua (named on the policy, data deletion page and the WhatsApp "privacy" reply). Registered address of Incolo Systems: optional, add it if you want it on the policy.

## Platform → Website → testing instructions (answers)
1. **Where can we find the app?** https://q.incolo.si (web dashboard for clinic staff; patients use it through the clinic's WhatsApp number).
2. **Instructions for accessing the app:** open https://q.incolo.si/login → enter **9000000099** → "Send code on WhatsApp" → enter the reviewer code (no WhatsApp message is sent for this test login) → Sign in. Queue board and Appointments are in the left menu; to book, Appointments → pick a free slot → Book. The WhatsApp side is shown in the screencasts (our test number only delivers to registered recipients).
3. **Is Facebook Login integrated?** Not yet. Facebook Login for Business will be used only for WhatsApp Embedded Signup, when a clinic connects its WhatsApp Business Account; staff log in with a WhatsApp one-time code.
4. **Access codes / test credentials:** phone **9000000099**, code = the reviewer code (stored as the SSM secret `/clinicq/REVIEWER_CODE`; given to the reviewer only, never committed). Free during review; no payment or membership needed.
5. **Gift codes:** not applicable: a free web app, nothing to download from an app store.
6. **Geo restrictions:** none: the website is reachable worldwide, no geo-blocking.

The reviewer login (`REVIEWER_PHONE` in the env base + `/clinicq/REVIEWER_CODE`) signs in as "App Reviewer", an ordinary staff member of the demo clinic (never on duty, never an Incolo admin). Switch it off after approval: delete the SSM parameter and run `install.sh update`.
