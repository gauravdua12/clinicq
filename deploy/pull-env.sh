#!/usr/bin/env bash
# Write /etc/clinicq/clinicq.env (base settings + SecureStrings from SSM /clinicq/*) and the Flow private key.
# Run as root on the server. Values never reach git or the logs.
set -euo pipefail
cd "$(dirname "$0")"
REGION="${AWS_REGION:-ap-south-1}"
umask 027
mkdir -p /etc/clinicq
TMP=$(mktemp /etc/clinicq/.env.XXXXXX)
grep -v '^\s*#' clinicq.env.base | grep -v '^\s*$' > "$TMP"
aws ssm get-parameters-by-path --region "$REGION" --path /clinicq/ --with-decryption --query 'Parameters[*].[Name,Value]' --output json |
  python3 -c '
import json,sys
for name,value in json.load(sys.stdin):
    k=name.rsplit("/",1)[1]
    if k=="FLOW_PRIVATE_KEY": open("/etc/clinicq/flow_private.pem","w").write(value.replace("\\n","\n")); continue
    print(f"{k}=\x27{value}\x27")' >> "$TMP"
for k in META_APP_SECRET WA_ACCESS_TOKEN META_VERIFY_TOKEN DATA_KEY HASH_PEPPER SESSION_SECRET; do
  grep -q "^$k=" "$TMP" || { echo "Missing /clinicq/$k in Parameter Store"; rm -f "$TMP"; exit 1; }
done
chown root:clinicq "$TMP" && chmod 640 "$TMP" && mv "$TMP" /etc/clinicq/clinicq.env
[ -f /etc/clinicq/flow_private.pem ] && chown root:clinicq /etc/clinicq/flow_private.pem && chmod 640 /etc/clinicq/flow_private.pem
echo "/etc/clinicq/clinicq.env written ($(wc -l < /etc/clinicq/clinicq.env) settings)"
