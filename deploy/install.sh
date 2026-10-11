#!/usr/bin/env bash
# ClinicQ on the time-shared demo server (docs/DEPLOYMENT.md §1a). Everything lives under /opt/clinicq and
# /etc/clinicq; watsappai's files are never touched. Run as root:
#   deploy/install.sh first     clone, build, migrate, seed (empty DB only), install services + demo-switch (starts nothing public)
#   deploy/install.sh update    fetch, build, migrate; if ClinicQ is the live demo, restart it (automatic rollback if unhealthy)
set -euo pipefail
APP=/opt/clinicq/app
REPO=git@github.com:gauravdua12/clinicq.git
AS="sudo -u clinicq -H"
HEALTH=http://127.0.0.1:8090/healthz

build() {
  cd "$APP"
  # Low priority + capped heap: the build never starves whatever else is running.
  $AS env NODE_OPTIONS=--max-old-space-size=900 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 nice -n 15 npm ci --no-audit --no-fund --loglevel=error
  $AS env NODE_OPTIONS=--max-old-space-size=900 NEXT_PUBLIC_BASE_PATH= NEXT_TELEMETRY_DISABLED=1 nice -n 15 npm run build --silent
}
migrate() { cd "$APP" && $AS bash -c 'set -a; . /etc/clinicq/clinicq.env; set +a; npm run db:deploy --silent'; }
healthy() { for _ in $(seq 1 30); do curl -fsS "$HEALTH" 2>/dev/null | grep -q '"ok":true' && return 0; sleep 2; done; return 1; }
live() { [ "$(cat /etc/demo-mode 2>/dev/null)" = clinicq ]; }
units() {
  install -m 644 "$APP/deploy/clinicq.service" /etc/systemd/system/clinicq.service
  install -m 644 "$APP/deploy/clinicq-caddy.service" /etc/systemd/system/clinicq-caddy.service
  install -m 755 "$APP/deploy/demo-switch.sh" /usr/local/bin/demo-switch
  systemctl daemon-reload
}
caddy_bin() {
  [ -x /opt/clinicq/bin/caddy ] && return 0
  local v; v=$(curl -fsS https://api.github.com/repos/caddyserver/caddy/releases/latest | python3 -c 'import json,sys;print(json.load(sys.stdin)["tag_name"].lstrip("v"))')
  local d; d=$(mktemp -d); cd "$d"
  curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v$v/caddy_${v}_linux_arm64.tar.gz"
  curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v$v/caddy_${v}_checksums.txt"
  grep " caddy_${v}_linux_arm64.tar.gz\$" "caddy_${v}_checksums.txt" | sha512sum -c - >/dev/null || { echo "Caddy checksum mismatch"; exit 1; }
  tar -xzf "caddy_${v}_linux_arm64.tar.gz" caddy
  install -d -o clinicq -g clinicq /opt/clinicq/bin /opt/clinicq/caddy
  install -m 755 caddy /opt/clinicq/bin/caddy
  cd / && rm -rf "$d"
  echo "Caddy $v installed (checksum verified)"
}

if [ "${1:-}" = first ]; then
  [ -d "$APP/.git" ] || $AS git clone -q "$REPO" "$APP"
  "$APP/deploy/pull-env.sh"
  build
  migrate
  cd "$APP"
  if [ "$($AS psql -d clinicq -tAc 'select count(*) from "Clinic"')" = 0 ]; then
    $AS bash -c "set -a; . /etc/clinicq/clinicq.env; set +a; SEED_DISPLAY_KEY=$(openssl rand -hex 12) npx tsx packages/db/src/seed.ts" | tail -1
  fi
  caddy_bin
  install -d -o clinicq -g clinicq /opt/clinicq/caddy
  units
  /opt/clinicq/bin/caddy validate --config "$APP/deploy/Caddyfile" --adapter caddyfile >/dev/null 2>&1 && echo "Caddyfile valid"
  echo "Installed. Make ClinicQ the live demo with: sudo demo-switch clinicq"
  exit 0
fi

if [ "${1:-}" = update ]; then
  cd "$APP"
  PREV=$($AS git rev-parse HEAD)
  $AS git fetch -q origin && $AS git reset -q --hard origin/main
  echo "Updating ${PREV:0:7} → $($AS git rev-parse --short HEAD)"
  "$APP/deploy/pull-env.sh"
  units
  if ! live; then build && migrate && echo "Built (ClinicQ isn't the live demo; nothing restarted)"; exit 0; fi
  if build && migrate && systemctl restart clinicq && healthy && systemctl reload-or-restart clinicq-caddy; then
    echo "Updated and healthy: $(curl -s $HEALTH)"
  else
    echo "Update failed, rolling back to ${PREV:0:7}"
    $AS git reset -q --hard "$PREV"
    build && systemctl restart clinicq && healthy && echo "Rolled back and healthy" || { echo "ROLLBACK FAILED"; journalctl -u clinicq -n 40 --no-pager; exit 2; }
    exit 1
  fi
  exit 0
fi
sed -n '2,6p' "$0"
