#!/bin/sh
# Replay a captured gateway state through the real server and print what it
# samples. Everything runs on localhost in a scratch directory; the live
# appliance, history.jsonl and outages.jsonl are untouched.
#
#   ./test/replay.sh docs/gateway-captures/2026-09-28-islanded [seconds]
#
# Expect for the islanded capture: "offGrid":true, loadW 734.28, battW 734.28,
# and an "[outage] grid down" line. The server reads .enphase_token from the
# repo root; any non-empty file will do, the fake gateway only checks that
# an Authorization header is present.
set -eu
CAP="${1:?usage: replay.sh <capture-dir> [seconds]}"
SECS="${2:-45}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GW_PORT=8449
WORK="$(mktemp -d "${TMPDIR:-/tmp}/enphase-replay.XXXXXX")"
trap 'kill $GW_PID $SRV_PID 2>/dev/null; wait $GW_PID $SRV_PID 2>/dev/null; rm -rf "$WORK"' EXIT

[ -f "$ROOT/build-server/server.js" ] || { echo "run npm run build first"; exit 1; }
[ -s "$ROOT/.enphase_token" ] || { echo "need a non-empty .enphase_token in $ROOT"; exit 1; }

node "$ROOT/test/fake-gateway.mjs" "$CAP" $GW_PORT > "$WORK/gateway.log" 2>&1 &
GW_PID=$!
SRV_PID=
sleep 1

GATEWAY_HOST=127.0.0.1:$GW_PORT GATEWAY_FALLBACK=127.0.0.1:$GW_PORT \
PORT=8443 HTTP_PORT=8080 \
HISTORY_FILE="$WORK/history.jsonl" OUTAGES_FILE="$WORK/outages.jsonl" \
TLS_CERT="$WORK/cert.pem" TLS_KEY="$WORK/key.pem" \
node "$ROOT/build-server/server.js" > "$WORK/server.log" 2>&1 &
SRV_PID=$!

echo "replaying $CAP for ${SECS}s ..."
sleep "$SECS"
echo "=== /api/status"
curl -sk --max-time 20 https://localhost:8443/api/status; echo
echo "=== server log"
grep -E '^\[' "$WORK/server.log" || true
echo "=== outages.jsonl"
cat "$WORK/outages.jsonl" 2>/dev/null || echo "(none)"
echo "=== fake gateway requests"
grep -c 'fake-gateway\] GET\|fake-gateway\] POST' "$WORK/gateway.log" | sed 's/$/ requests served/'
grep '404' "$WORK/gateway.log" | sort | uniq -c || true
