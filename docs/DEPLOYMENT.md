# Deployment on AWS (ap-south-1 Mumbai): simple, no containers, no license costs

## 1. Target
| Piece | Choice | Approx. cost/month |
|---|---|---|
| Compute | **The existing watsappai EC2 server**, time-shared with watsappai, ClinicQ at `https://q.incolo.si` (§1a). For a dedicated box later: EC2 `t4g.small` (2 vCPU ARM, 2 GB), Ubuntu 24.04, with an IAM instance role | shared (≈ ₹0 extra); dedicated ~$12 |
| Database | PostgreSQL 16 **on the same instance** (gp3 30 GB EBS). Can move to RDS `db.t4g.micro` (~$15) later | EBS ~$3 |
| HTTPS | Caddy 2 (free, automatic Let's Encrypt) + an Elastic IP | free |
| Backups | `pg_dump` → encrypted with `age` → **S3** (`BACKUP_S3_BUCKET`), lifecycle 14 days | < $1 |
| AI | Amazon Bedrock (Mantle endpoint, Mumbai): **Qwen3 32B**, failing over to **Mistral Large 3**. See MODEL_SELECTION.md | ~₹150–400 at 60 patients/day |
| Voice | Bedrock **Voxtral Small** (fallback Voxtral Mini). OGG/Opus is decoded in memory | ~₹50–150 |
| DNS | Route 53 or the domain registrar | ~$0.5 |
Everything runs in India regions. Docker isn't used.

## 1a. Demo server: time-shared with watsappai (q.incolo.si)
ClinicQ and watsappai share the `incolo-prod` server (t4g.small, Amazon Linux 2023, 1.8 GB RAM + 2 GB swap, reached through SSM Session Manager). **Only one of them is live at a time**: whichever is live owns ports 80/443. watsappai's files, containers and config are never edited. It is only stopped and started with its own compose file.

| | watsappai | ClinicQ |
|---|---|---|
| Address | https://app.incolo.si | **https://q.incolo.si** (DNS A record `q` → 13.207.113.241) |
| Runs as | Docker Compose in `~ec2-user/watsappai` (its own Caddy, app, Postgres) | systemd on the host: `clinicq` (app, 127.0.0.1:8090), `clinicq-caddy` (HTTPS, `/opt/clinicq/bin/caddy`), `postgresql` (database `clinicq`) |
| Files | `~ec2-user/watsappai`, Docker volumes | `/opt/clinicq` (app, Caddy binary and certificates), `/etc/clinicq` (settings) |
| Meta app / webhook | its own | its own: `https://q.incolo.si/webhook` |

**Switch with one command** (in an SSM session on the server):
```bash
sudo demo-switch status       # what's live, ports, free memory
sudo demo-switch clinicq      # stop watsappai → start ClinicQ (rolls back to watsappai if ClinicQ isn't healthy)
sudo demo-switch watsappai    # stop ClinicQ → start watsappai (rolls back to ClinicQ if watsappai isn't healthy)
```
The chosen mode survives a reboot (ClinicQ's services are enabled or disabled; watsappai's containers stay stopped after `docker compose stop`).

**While one is switched off:** WhatsApp messages to its number are not answered. Meta keeps retrying for up to 7 days. ClinicQ ignores re-delivered messages older than 30 minutes (`STALE_INBOUND_MIN`) and sends at most one "please send your request again". Its reminders and scheduled jobs catch up when it starts. watsappai's hourly backup cron logs failures while it is stopped.

**Settings and secrets:** non-secret settings live in `deploy/clinicq.env.base` (committed). Secrets are SecureStrings in SSM under `/clinicq/` (`META_APP_SECRET`, `WA_ACCESS_TOKEN`, `META_VERIFY_TOKEN`, `DATA_KEY`, `HASH_PEPPER`, `SESSION_SECRET`, `FLOW_PRIVATE_KEY`). `deploy/pull-env.sh` merges them into `/etc/clinicq/clinicq.env` (root:clinicq 640). The instance role has an inline policy `clinicq`: read `/clinicq/*`, plus `bedrock-mantle:*Inference`.
> **Back up `DATA_KEY` and `HASH_PEPPER` offline.** Without them, the stored phone numbers can't be decrypted.

**Install and update** (as root):
```bash
/opt/clinicq/app/deploy/install.sh first    # clone (read-only deploy key), build, migrate, seed (empty DB only), install services + demo-switch
/opt/clinicq/app/deploy/install.sh update   # fetch, build, migrate; restarts only if ClinicQ is live (automatic rollback if unhealthy)
```
The Caddy binary comes from Caddy's official GitHub release, with its checksum verified. The seed script refuses to run on a production database that already has data.

## 2. Local development (macOS)
```bash
brew install node@24 postgresql@16 && brew services start postgresql@16
createuser -s clinicq && createdb -O clinicq clinicq && createdb -O clinicq clinicq_test
cp .env.example .env            # WA_MODE=mock, STT_PROVIDER=mock, EXTRACTOR_PRIMARY=rules work offline
npm install && npm run db:migrate && npm run db:seed
npm run dev                     # http://localhost:8080 (dashboard), /dev/simulator, /display?key=dev
```
To use Bedrock and Transcribe from your laptop: `aws configure sso` (or a profile with access keys), `export AWS_PROFILE=clinicq`, and set `EXTRACTOR_PRIMARY` / `STT_PROVIDER` in `.env`.
To test with Meta's test number locally, expose the server with a free tunnel (`cloudflared tunnel --url http://localhost:8080`) and set the webhook URL in the Meta app.

## 3. AWS account setup (once)
1. **Region:** `ap-south-1`. Turn on MFA for root, and create an admin IAM Identity Center user.
2. **Account plan:** upgrade from the Free plan to the Paid plan (remaining credits are kept). Some Bedrock features need it: Claude via Marketplace, classic Bedrock quotas, Amazon Transcribe. The chosen models (Qwen3 32B, Mistral Large 3, Voxtral) already work on the Mantle endpoint. See `docs/runbooks/aws-bedrock-access.md`.
2b. **Mantle data retention:** for each model in use, set the data-retention mode to **none** (Bedrock console → model → data retention, or the Mantle API). Record the setting in §8.
3. **Bedrock invocation logging: keep it OFF** (Settings → Model invocation logging).
4. **AI services opt-out policy** (AWS Organizations → Policies → AI services opt-out), for Transcribe and Bedrock. If the account isn't in an Organization, create one (free).
5. **IAM role `clinicq-ec2`**, with a policy along these lines:
```json
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["bedrock-mantle:CreateInference", "bedrock-mantle:Get*", "bedrock-mantle:List*"], "Resource": "*" },
  { "Effect": "Allow", "Action": ["s3:PutObject","s3:ListBucket","s3:GetObject"],
    "Resource": ["arn:aws:s3:::<backup-bucket>","arn:aws:s3:::<backup-bucket>/*"] } ] }
```
6. **S3 backup bucket:** block public access, SSE-S3 encryption, a lifecycle rule to expire after 14 days, and versioning off.
7. **EC2:** launch a `t4g.small` (Ubuntu 24.04 arm64) with the role attached, 30 GB gp3 encrypted. The security group allows 80 and 443 from anywhere, and 22 from your IP only (or use SSM Session Manager and no port 22). Attach an Elastic IP and point the DNS A record at it.
8. **Billing alarm:** a budget of ₹3,000/month with email alerts.

## 4. Server provisioning (once, on EC2)
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install postgresql-16 caddy ufw unattended-upgrades age awscli
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt -y install nodejs
sudo adduser --system --group --home /opt/clinicq clinicq
sudo -u postgres createuser clinicq && sudo -u postgres createdb -O clinicq clinicq
sudo mkdir -p /etc/clinicq && sudo chmod 750 /etc/clinicq && sudo chown root:clinicq /etc/clinicq
# /etc/clinicq/clinicq.env (mode 640) and /etc/clinicq/flow_private.pem (mode 640)
```
Postgres listens on localhost only. SSH is key-only. No AWS keys live on the server (the instance role provides credentials).

## 5. App service
`/etc/systemd/system/clinicq.service`
```ini
[Unit]
Description=ClinicQ
After=network.target postgresql.service

[Service]
User=clinicq
WorkingDirectory=/opt/clinicq/app
EnvironmentFile=/etc/clinicq/clinicq.env
ExecStart=/usr/bin/node apps/server/dist/main.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/clinicq
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```
`/etc/caddy/Caddyfile`
```
clinic.example.in {
  encode gzip
  reverse_proxy 127.0.0.1:8080 {
    flush_interval -1
  }
  header Strict-Transport-Security "max-age=31536000"
}
```

## 6. Release
```bash
cd /opt/clinicq/app && git pull --ff-only
npm ci && npm run build && npm run db:deploy
sudo systemctl restart clinicq && curl -fsS https://q.incolo.si/healthz
```
Restarting is safe: scheduled jobs live in Postgres (`ScheduledJob`) and resume, and the webhook dedupes on `wamid`. If the database is unreachable, the webhook returns 500 so Meta retries later, and the scheduler logs `job_poll_failed` and keeps polling. The service recovers by itself (tested; see TEST_REPORT.md). Deploy outside clinic hours.

## 7. Backups and restore
- Nightly at 02:00 IST (cron as `clinicq`): `scripts/backup.sh` → `pg_dump -Fc | age -r <pubkey> | aws s3 cp - s3://$BACKUP_S3_BUCKET/clinicq-$(date +%F).dump.age`
- The `age` private key is kept **offline** by the doctor or operator.
- **Monthly restore test:** restore to a scratch database and run `npm run db:verify`.

## 8. Go-live checklist
- [ ] Meta setup complete (WHATSAPP_INTEGRATION §1), templates approved EN and HI, Flow published
- [ ] `WA_MODE=cloud`; webhook verified; round trip from a staff phone
- [ ] Bedrock model access enabled; invocation logging OFF; AI opt-out policy applied
- [ ] Extraction eval run on the configured primary + escalation (meets AI_EXTRACTION §7 targets); report saved
- [ ] Voice: send a real WhatsApp voice note (OGG/Opus) from a phone on the Meta test number and confirm the transcript (Voxtral Small). Then run 30 Hinglish samples.
- [ ] Privacy notice reviewed by a lawyer; `noticeVersion` set; grievance contact filled in
- [ ] Clinic settings complete; QR printed; TV page in kiosk mode
- [ ] Backups to S3 running, with one restore test done
- [ ] `npm run test:boundary` green on the release commit
- [ ] Staff walkthrough (15 min); soft launch for one session

## 9. Monitoring (free or near-free)
- `journalctl -u clinicq` (redacted logs, logrotate 14 days). Optionally ship them to CloudWatch Logs with the agent. They contain no patient text by design.
- `/healthz` checked every 5 min by Route 53 health checks or a free uptime monitor.
- Alert on these log lines: `ai_models_unavailable` (both models failing, so the bot is on rules fallback), `job_poll_failed` (database unreachable), `unhandled_rejection`, `uncaught_exception` (the process exits and systemd restarts it).
- `system.alert` events (template paused, model or STT down, escalation rate over 30%) go to the doctor's WhatsApp.
