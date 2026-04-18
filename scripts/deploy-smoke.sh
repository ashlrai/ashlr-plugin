#!/usr/bin/env bash
# deploy-smoke.sh — post-deploy smoke test for ashlr production endpoints.
#
# Usage:
#   ASHLR_TOKEN=<api_token> ./scripts/deploy-smoke.sh
#
# Required env:
#   ASHLR_TOKEN   — a valid provisioned API token (from `bun run issue-token`)
#
# Optional env:
#   SITE_URL      — override site base (default: https://plugin.ashlr.ai)
#   API_URL       — override API base  (default: https://api.ashlr.ai)
#
# Exit codes:
#   0  — all checks passed
#   1  — one or more checks failed

set -euo pipefail

SITE_URL="${SITE_URL:-https://plugin.ashlr.ai}"
API_URL="${API_URL:-https://api.ashlr.ai}"
TOKEN="${ASHLR_TOKEN:-}"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
RST='\033[0m'

PASS=0
FAIL=0

pass() { echo -e "${GRN}PASS${RST}  $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${RST}  $1"; FAIL=$((FAIL + 1)); }
info() { echo -e "${YLW}----${RST}  $1"; }

# ---------------------------------------------------------------------------
# 1. Site health
# ---------------------------------------------------------------------------
info "Checking site health: ${SITE_URL}"

STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "${SITE_URL}" || echo "000")
if [ "$STATUS" = "200" ]; then
  pass "GET ${SITE_URL} → 200"
else
  fail "GET ${SITE_URL} → ${STATUS} (expected 200)"
fi

# robots.txt
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "${SITE_URL}/robots.txt" || echo "000")
if [ "$STATUS" = "200" ]; then
  pass "GET ${SITE_URL}/robots.txt → 200"
else
  fail "GET ${SITE_URL}/robots.txt → ${STATUS}"
fi

# sitemap.xml
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "${SITE_URL}/sitemap.xml" || echo "000")
if [ "$STATUS" = "200" ]; then
  pass "GET ${SITE_URL}/sitemap.xml → 200"
else
  fail "GET ${SITE_URL}/sitemap.xml → ${STATUS}"
fi

# ---------------------------------------------------------------------------
# 2. API health
# ---------------------------------------------------------------------------
info "Checking API health: ${API_URL}"

HEALTH=$(curl -sf "${API_URL}/" || echo "{}")
OK=$(echo "$HEALTH" | grep -o '"ok":true' || echo "")
if [ -n "$OK" ]; then
  pass "GET ${API_URL}/ → {ok: true}"
else
  fail "GET ${API_URL}/ → unexpected body: ${HEALTH}"
fi

# ---------------------------------------------------------------------------
# 3. Badge endpoint (no auth — public)
# ---------------------------------------------------------------------------
info "Checking badge endpoint"

if [ -z "$TOKEN" ]; then
  info "ASHLR_TOKEN not set — skipping authenticated badge + stats checks"
else
  # Upload a minimal stats payload to create a user record
  SYNC_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X POST "${API_URL}/stats/sync" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"stats":{"lifetime":{"calls":42,"tokensSaved":99000,"byTool":{},"byDay":{}}}}' \
    || echo "000")

  if [ "$SYNC_STATUS" = "200" ]; then
    pass "POST ${API_URL}/stats/sync → 200"
  else
    fail "POST ${API_URL}/stats/sync → ${SYNC_STATUS} (expected 200)"
  fi

  # Derive userId from token (first 8 chars as a smoke proxy — real impl uses DB lookup)
  # Instead, hit the aggregate endpoint to get the userId
  AGG=$(curl -sf \
    -H "Authorization: Bearer ${TOKEN}" \
    "${API_URL}/stats/aggregate" || echo "{}")
  USER_ID=$(echo "$AGG" | grep -o '"user_id":"[^"]*"' | cut -d'"' -f4 || echo "")

  if [ -n "$USER_ID" ]; then
    pass "GET ${API_URL}/stats/aggregate → user_id present"

    # Badge SVG
    BADGE=$(curl -sf "${API_URL}/u/${USER_ID}/badge.svg" || echo "")
    if echo "$BADGE" | grep -q "<svg"; then
      pass "GET ${API_URL}/u/${USER_ID}/badge.svg → SVG content"
    else
      fail "GET ${API_URL}/u/${USER_ID}/badge.svg → missing <svg element"
    fi

    # Check badge has token metric text
    if echo "$BADGE" | grep -qi "saved\|tokens\|calls"; then
      pass "Badge SVG contains expected metric text"
    else
      fail "Badge SVG missing metric text"
    fi
  else
    fail "GET ${API_URL}/stats/aggregate → user_id missing in response: ${AGG}"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "Results: ${GRN}${PASS} passed${RST}  ${RED}${FAIL} failed${RST}"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Smoke test FAILED${RST}"
  exit 1
else
  echo -e "${GRN}Smoke test PASSED${RST}"
  exit 0
fi
