# Running a ClinicQ demo

ClinicQ lives at **https://q.incolo.si** on the shared demo server. Patients talk to the clinic's WhatsApp number. Staff use the dashboard.

## 1. Make ClinicQ the live demo
In the AWS console, go to Systems Manager → Session Manager → `incolo-prod` → Start session, then run:
```bash
sudo demo-switch status      # what's live right now
sudo demo-switch clinicq     # stops watsappai, starts ClinicQ (about 10 s)
sudo demo-switch watsappai   # afterwards, if you want watsappai back
```
If the app you switch to doesn't come up healthy, the script puts the previous one back automatically.

## 2. The WhatsApp number
- **Today:** Meta's test number **+1 555 637 3528**. It can only exchange messages with numbers added as recipients in the Meta app (WhatsApp → API Setup → "To", up to 5). 9920323832 is already added. To let a prospect try it from their own phone, add their number there first (they receive a code from Meta).
- **Next:** 9654920201, connected through coexistence so the WhatsApp Business app keeps working on that phone (docs/META_ONBOARDING.md). After that, anyone can message it.

## 3. Show it
Your number (9920323832) is the demo **presenter**: it's both a patient and the clinic's doctor. Plain messages go to the patient side. Desk commands start with **#**: `#next`, `#status`, `#add Ramesh`, `#late 15`, `#summary`. Send `#` alone to see them all.

1. **Patient side:** from your phone, message the number "Hi", agree to the privacy notice, then type or say (voice note) something like *"kal shaam 6 baje mummy ke liye appointment"*.
2. **Desk side:** open https://q.incolo.si/login and enter 9920323832. The login code arrives on WhatsApp. Until Meta approves the login-code template, it comes as a normal message, which requires that you messaged the bot in the last 24 hours (step 1 covers this).
3. **The queue (today's patients):** book for *today* (e.g. *"aaj shaam 7 baje"*), then either reply *"I've reached"* from the phone or tap **Arrived** on the Appointments page. The patient joins the board as Waiting. Use **+ Add walk-in** for walk-ins. **Send next patient in**, then **✓ Consultation completed**. The patient gets "it's your turn" on WhatsApp. Open the waiting-room TV from Settings → **Walk-in QR & TV** → Open display.
4. **A prospect's own clinic in a minute:** go to Demo Studio (https://q.incolo.si/demo), enter the clinic name, its website or text from its prospectus, then **Create demo** and **Make active**. The bot and the dashboard now act as that clinic. Switch back by making the default clinic active again.

## 4. Still waiting on Meta
| Item | Status | What it unlocks |
|---|---|---|
| 24 message templates (EN + HI) | Pending review | Reminders and alerts outside the 24-hour window. Chat replies work already |
| Business verification (Incolo Systems) | Not started | Publishing the booking form (slot grid), the login-code template, and the limit going from 250 to 2,000 conversations a day |
| Permanent token | The current one expires 9 Dec 2026 | Regenerate with "Never" and update `/clinicq/WA_ACCESS_TOKEN` in Parameter Store, then run `sudo /opt/clinicq/app/deploy/install.sh update` |

## 5. Health and updates
- Health: https://q.incolo.si/healthz shows `{"ok":true,"db":true}`.
- Full post-deploy check (about 30 s, cleans up after itself):
  `sudo -u clinicq -H bash -c 'set -a; . /etc/clinicq/clinicq.env; set +a; cd /opt/clinicq/app && npx tsx scripts/ops/live-check.ts'`
- Update to the latest code: `sudo /opt/clinicq/app/deploy/install.sh update` (rolls back automatically if unhealthy).
