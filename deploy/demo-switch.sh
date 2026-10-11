#!/usr/bin/env bash
# The demo server is time-shared: watsappai OR ClinicQ owns ports 80/443, never both.
# Installed as /usr/local/bin/demo-switch by deploy/install.sh. watsappai's files are never edited; it is only
# stopped/started with its own compose file.
#   sudo demo-switch status
#   sudo demo-switch clinicq      stop watsappai, start ClinicQ  (rolls back if ClinicQ isn't healthy)
#   sudo demo-switch watsappai    stop ClinicQ, start watsappai  (rolls back if watsappai isn't healthy)
set -uo pipefail
WA_DIR=/home/ec2-user/watsappai
WA_HOST=app.incolo.si
CQ_HOST=q.incolo.si
STATE=/etc/demo-mode
wa() { (cd "$WA_DIR" && docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env "$@"); }

[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
exec 9>/run/demo-switch.lock; flock -n 9 || { echo "Another switch is already running."; exit 1; }

wa_running() { [ -n "$(wa ps --status running -q 2>/dev/null)" ]; }
ports_busy() { ss -ltnH '( sport = :80 or sport = :443 )' | grep -q .; }
wait_ports_free() { for _ in $(seq 1 20); do ports_busy || return 0; sleep 1; done; return 1; }
# Check through the real HTTPS front end, pinned to this machine (no DNS/hairpin dependency).
https_ok() { for _ in $(seq 1 "${3:-45}"); do curl -fsS -m 5 --resolve "$1:443:127.0.0.1" "https://$1$2" >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
say() { echo "[$(date +%H:%M:%S)] $*"; }

stop_clinicq() { systemctl stop clinicq-caddy clinicq; systemctl disable -q clinicq-caddy clinicq postgresql; systemctl stop postgresql; }
start_clinicq() {
  [ -f /opt/clinicq/app/apps/server/dist/main.js ] && [ -f /etc/clinicq/clinicq.env ] || { say "ClinicQ is not installed/built."; return 1; }
  chown -R clinicq:clinicq /opt/clinicq/caddy 2>/dev/null
  systemctl start postgresql clinicq || return 1
  for _ in $(seq 1 30); do curl -fsS -m 3 http://127.0.0.1:8090/healthz 2>/dev/null | grep -q '"ok":true' && break; sleep 1; done
  curl -fsS -m 3 http://127.0.0.1:8090/healthz 2>/dev/null | grep -q '"ok":true' || { say "ClinicQ app unhealthy"; return 1; }
  systemctl start clinicq-caddy || return 1
  https_ok "$CQ_HOST" /healthz || { say "https://$CQ_HOST not answering (DNS or certificate?)"; return 1; }
  systemctl enable -q postgresql clinicq clinicq-caddy
}
stop_wa() { wa stop >/dev/null 2>&1; }
start_wa() { wa start >/dev/null 2>&1 || wa up -d --no-build >/dev/null 2>&1 || return 1; https_ok "$WA_HOST" /health 60; }

status() {
  echo "Mode:       $(cat "$STATE" 2>/dev/null || echo unknown)"
  echo "watsappai:  $(wa_running && echo running || echo stopped)"
  echo "ClinicQ:    app $(systemctl is-active clinicq), https $(systemctl is-active clinicq-caddy), db $(systemctl is-active postgresql)"
  ss -ltnpH '( sport = :80 or sport = :443 )' | awk '{print "  port " $4 "  " $6}'
  free -m | awk 'NR==2{print "Memory:     " $7 " MB available of " $2}'
}

case "${1:-status}" in
  status) status ;;
  clinicq)
    if systemctl is-active -q clinicq-caddy && ! wa_running; then say "ClinicQ is already the live demo."; status; exit 0; fi
    say "Stopping watsappai…"; stop_wa
    wait_ports_free || { say "Ports 80/443 still busy, restoring watsappai"; start_wa; exit 1; }
    say "Starting ClinicQ…"
    if start_clinicq; then echo clinicq > "$STATE"; say "ClinicQ is live at https://$CQ_HOST"; status
    else say "ClinicQ failed to start, restoring watsappai"; stop_clinicq; wait_ports_free; start_wa && echo watsappai > "$STATE" && say "watsappai restored" || say "WARNING: watsappai did not come back, check: sudo demo-switch status"; exit 1; fi ;;
  watsappai)
    if wa_running && ! systemctl is-active -q clinicq-caddy; then say "watsappai is already the live demo."; status; exit 0; fi
    say "Stopping ClinicQ…"; stop_clinicq
    wait_ports_free || { say "Ports 80/443 still busy"; exit 1; }
    say "Starting watsappai…"
    if start_wa; then echo watsappai > "$STATE"; say "watsappai is live at https://$WA_HOST"; status
    else say "watsappai failed to start, restoring ClinicQ"; stop_wa; wait_ports_free; start_clinicq && echo clinicq > "$STATE" && say "ClinicQ restored"; exit 1; fi ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
