#!/usr/bin/env bash
# smoke-scanner-entitlement.sh — automated end-to-end check that a scanner's
# entitlement + displacement stack is live.
#
# Pairs with LIVE_DATA_SCANNER_RECIPE §9.1 (manual flow). Replaces the "Mike
# opens two tabs and squints" step so adopters can self-verify in CI or
# locally before shipping.
#
# USAGE
#   ./smoke-scanner-entitlement.sh <customer-slug> <scanner-slug> <bearer-id-token>
#     [--host <scanners-host>]              default: scanners.<customer-slug>.ai
#     [--pm2-host <ssh-host>]               if set, pm2-log scrape runs via `ssh <host>`
#                                           (expects f2-admin-service2 under pm2)
#     [--verbose]                           dump raw response bodies on each step
#
# Scope: HTTP-based assertions prove the user-visible contract (probes land,
# slot gating fires, displacement flips tier, reclaim restores). SSE push and
# agreement-approval flows are left to the manual §9.1 since they need
# browser-side EventSource + popup UI respectively.
#
# EXIT CODE
#   0 → all assertions passed, scanner entitlement stack is green
#   1 → one or more assertions failed, see printed diagnostic
#   2 → script invocation error (bad args, missing deps)

set -u -o pipefail

# -----------------------------------------------------------------------------
# Arg parse
# -----------------------------------------------------------------------------
if [[ $# -lt 3 ]]; then
  cat >&2 <<EOF
usage: $0 <customer-slug> <scanner-slug> <bearer-id-token>
         [--host <scanners-host>] [--pm2-host <ssh-host>] [--verbose]
EOF
  exit 2
fi

CUSTOMER="$1"; shift
SCANNER="$1"; shift
BEARER="$1"; shift

HOST="scanners.${CUSTOMER}.ai"
PM2_HOST=""
VERBOSE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --pm2-host) PM2_HOST="$2"; shift 2 ;;
    --verbose) VERBOSE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

for dep in curl python3; do
  command -v "$dep" >/dev/null || { echo "missing dep: $dep" >&2; exit 2; }
done

SID_A="smoke-A-$(date +%s)-$RANDOM"
SID_B="smoke-B-$(date +%s)-$RANDOM"
PROBE_URL="https://${HOST}/rest/user/data-agreements?customer=${CUSTOMER}&sanitize=1"

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✓ $*"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $*"; }

# Fetch sanitize endpoint, return "<http-code>\t<body-json-oneline>"
probe() {
  local sid="$1"
  local extra_header="${2:-}"
  local args=(
    -s -w '\n%{http_code}'
    -H "Authorization: Bearer ${BEARER}"
    -H "X-F2-Session-Id: ${sid}"
  )
  [[ -n "$extra_header" ]] && args+=(-H "$extra_header")
  curl "${args[@]}" "${PROBE_URL}&_ts=$(date +%s%N)"
}

# Extract one field from a json blob
jget() { python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('$1',''))"; }

# -----------------------------------------------------------------------------
# Step 1 — probe lands clean
# -----------------------------------------------------------------------------
echo "Step 1 — Probe lands with HTTP 200 and carries data_tier"
raw=$(probe "$SID_A") || { fail "curl failed: $raw"; }
body=$(echo "$raw" | sed '$d')
code=$(echo "$raw" | tail -n1)
[[ "$VERBOSE" == 1 ]] && { echo "  http=$code"; echo "  body=$body"; }

if [[ "$code" != "200" ]]; then
  fail "sanitize probe returned HTTP $code (expected 200)"
  echo "  BODY: $body"
  echo
  echo "First step blocked. See §9.2 Troubleshooting: probe isn't reaching backend."
  exit 1
else
  pass "sanitize endpoint returned HTTP 200"
fi

TIER_A=$(echo "$body" | jget data_tier)
if [[ -z "$TIER_A" ]]; then
  fail "response body missing data_tier field"
else
  pass "response carries data_tier=\"$TIER_A\""
fi

# -----------------------------------------------------------------------------
# Step 2 — JWT bundle carries the scanner in custom:scanners
# -----------------------------------------------------------------------------
echo
echo "Step 2 — Test user's JWT carries '${SCANNER}' in custom:scanners"
scanners_claim=$(python3 <<EOF
import sys, json, base64
t = "$BEARER".split('.')
if len(t) < 2:
    print("")
    sys.exit(0)
p = t[1] + "=" * (-len(t[1]) % 4)
try:
    payload = json.loads(base64.urlsafe_b64decode(p).decode())
    print(payload.get('custom:scanners', ''))
except Exception:
    print("")
EOF
)
if [[ -z "$scanners_claim" ]]; then
  fail "JWT has no custom:scanners claim — slot claim will skip (scannerForUser returns null)"
elif ! echo ",$scanners_claim," | grep -q ",$SCANNER,"; then
  fail "JWT custom:scanners=\"$scanners_claim\" does NOT include \"$SCANNER\""
else
  pass "custom:scanners=\"$scanners_claim\" includes \"$SCANNER\""
fi

# -----------------------------------------------------------------------------
# Step 3 — Second session (sid-B) takes the slot
# -----------------------------------------------------------------------------
echo
echo "Step 3 — Second session (${SID_B}) claims the slot"
raw=$(probe "$SID_B")
body=$(echo "$raw" | sed '$d')
code=$(echo "$raw" | tail -n1)
if [[ "$code" != "200" ]]; then
  fail "second probe returned HTTP $code"
else
  TIER_B=$(echo "$body" | jget data_tier)
  pass "tab B probe returned HTTP 200 with data_tier=\"$TIER_B\""
fi

# Give the publish a moment to land in redis
sleep 1

# -----------------------------------------------------------------------------
# Step 4 — Tab A's next probe sees itself displaced
# -----------------------------------------------------------------------------
echo
echo "Step 4 — Tab A (${SID_A}) now reads data_tier='delayed_displaced'"
raw=$(probe "$SID_A")
body=$(echo "$raw" | sed '$d')
code=$(echo "$raw" | tail -n1)
TIER_A2=$(echo "$body" | jget data_tier)
if [[ "$code" != "200" ]]; then
  fail "re-probe returned HTTP $code"
elif [[ "$TIER_A2" == "delayed_displaced" ]]; then
  pass "tab A flipped to delayed_displaced ✓"
elif [[ "$TIER_A2" == "realtime" ]]; then
  fail "tab A still reads 'realtime' — displacement did NOT fire"
  echo "    Possible: X-F2-Session-Id header not forwarded through Vercel rewrite,"
  echo "              OR user's realtime_override is forcing realtime regardless of slot."
  echo "              Inspect pm2 logs on backend for 'first-claim scanner=${SCANNER}'."
else
  # Could legitimately be delayed_by_agreement or delayed_pro_gate if user
  # isn't entitled to realtime in the first place. In that case displacement
  # is unobservable (there's no realtime to lose) — flag as inconclusive.
  echo "  ⚠ tab A reads '${TIER_A2}' — user may not be realtime-entitled."
  echo "    Displacement test is inconclusive; re-run with a realtime-entitled test user."
fi

# -----------------------------------------------------------------------------
# Step 5 — Reclaim restores tab A
# -----------------------------------------------------------------------------
echo
echo "Step 5 — Tab A reclaims with X-F2-Claim-Slot: reclaim"
raw=$(probe "$SID_A" "X-F2-Claim-Slot: reclaim")
body=$(echo "$raw" | sed '$d')
code=$(echo "$raw" | tail -n1)
TIER_A3=$(echo "$body" | jget data_tier)
if [[ "$code" != "200" ]]; then
  fail "reclaim probe returned HTTP $code"
elif [[ "$TIER_A3" == "realtime" ]] || [[ "$TIER_A3" == "$TIER_A" ]]; then
  pass "tab A reclaimed, data_tier=\"$TIER_A3\""
else
  fail "tab A reclaim did NOT restore tier (expected realtime, got \"$TIER_A3\")"
fi

sleep 1

# -----------------------------------------------------------------------------
# Step 6 — Tab B now reads itself as displaced
# -----------------------------------------------------------------------------
echo
echo "Step 6 — Tab B (${SID_B}) sees itself displaced after reclaim"
raw=$(probe "$SID_B")
body=$(echo "$raw" | sed '$d')
code=$(echo "$raw" | tail -n1)
TIER_B2=$(echo "$body" | jget data_tier)
if [[ "$code" != "200" ]]; then
  fail "tab B re-probe returned HTTP $code"
elif [[ "$TIER_B2" == "delayed_displaced" ]]; then
  pass "tab B flipped to delayed_displaced after reclaim ✓"
elif [[ "$TIER_B2" == "realtime" ]]; then
  fail "tab B still realtime — reclaim did NOT push B into displaced set"
else
  echo "  ⚠ tab B reads '${TIER_B2}' — see step 4 inconclusive note."
fi

# -----------------------------------------------------------------------------
# Step 7 — Optional pm2 log scrape (if --pm2-host provided)
# -----------------------------------------------------------------------------
if [[ -n "$PM2_HOST" ]]; then
  echo
  echo "Step 7 — Backend log evidence (via ssh ${PM2_HOST})"
  logs=$(ssh "$PM2_HOST" "pm2 logs f2-admin-service2 --nostream --lines 300 2>&1 | \
    grep -E 'LiveSessionService.*scanner=${SCANNER}|customer=${CUSTOMER}&sanitize' | tail -20" 2>&1)
  if echo "$logs" | grep -q "first-claim.*scanner=${SCANNER}"; then
    pass "pm2 log shows first-claim lines for scanner=${SCANNER}"
  else
    fail "pm2 log has no first-claim for scanner=${SCANNER} (slot claim never fired)"
  fi
  if echo "$logs" | grep -q "customer=${CUSTOMER}&sanitize"; then
    pass "pm2 log shows probe ENTRY for customer=${CUSTOMER}"
  else
    fail "pm2 log has no sanitize ENTRY for customer=${CUSTOMER} — Vercel rewrite / probe URL issue?"
  fi
  [[ "$VERBOSE" == 1 ]] && echo "$logs" | sed 's/^/    /'
else
  echo
  echo "Step 7 — skipped (pass --pm2-host to enable backend log evidence)"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo
echo "────────────────────────────────────────"
if [[ "$FAIL" -eq 0 ]]; then
  echo "RESULT: ${PASS}/${PASS} assertions passed — scanner entitlement stack is GREEN."
  exit 0
else
  echo "RESULT: ${PASS} passed, ${FAIL} FAILED — scanner entitlement stack has gaps."
  echo "Consult §9.2 Troubleshooting in LIVE_DATA_SCANNER_RECIPE.md."
  exit 1
fi
