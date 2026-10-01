#!/bin/sh
# Snapshot every gateway endpoint this project cares about into
# docs/gateway-captures/<UTC timestamp>-<label>/ so a state can be replayed
# later with test/replay.sh. Run it from the repo root on any box that has
# .enphase_token (normally the appliance, over ssh):
#
#   ssh willow-server 'cd ~/enphase_local && ./deploy/capture-gateway.sh on-grid'
#
# File names are the URL path with "/" -> "_" and the query string dropped,
# which is what test/fake-gateway.mjs maps back.
set -u
LABEL="${1:?usage: capture-gateway.sh <label> [gateway-host]}"
GW="${2:-192.168.0.148}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOK="$(tr -d '[:space:]' < "$ROOT/.enphase_token")"
OUT="$ROOT/docs/gateway-captures/$(date -u +%Y-%m-%dT%H%MZ)-$LABEL"
mkdir -p "$OUT"

for ep in \
  ivp/ensemble/secctrl \
  ivp/ensemble/relay \
  ivp/livedata/status \
  'production.json?details=1' \
  ivp/ensemble/status \
  ivp/ensemble/inventory \
  ivp/meters/readings \
  ivp/ensemble/dry_contacts \
  admin/lib/tariff \
  home.json
do
  name="$(printf '%s' "$ep" | sed 's/?.*//; s#/#_#g')"
  case "$name" in *.json) ;; *) name="$name.json" ;; esac
  code="$(curl -sk --max-time 30 -H "Authorization: Bearer $TOK" \
    "https://$GW/$ep" -o "$OUT/$name" -w '%{http_code}')"
  if [ "$code" != "200" ]; then
    rm -f "$OUT/$name"
    echo "$ep -> HTTP $code (not saved)"
  else
    echo "$ep -> $OUT/$name"
  fi
done
