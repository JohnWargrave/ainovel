#!/usr/bin/env bash
#
# Runnable walkthrough of the direct coin credit API (POST /earning/coin).
# See ainovel-document/direct-coin-api.md for the contract.
#
#   ./scripts/direct-coin-curl.sh
#
# Override anything via env:
#   BASE_URL=https://staging.example.com CMS_EMAIL=me@x.com CMS_PASSWORD=... ./scripts/direct-coin-curl.sh
#
# Requires: curl, jq. Requires the server running and `pnpm migrate up` already applied.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
CMS_EMAIL="${CMS_EMAIL:-admin@ainovel.local}"
CMS_PASSWORD="${CMS_PASSWORD:-}"
MAX_AMOUNT_COIN="${MAX_AMOUNT_COIN:-1000}"

COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

hr() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
jqp() { jq . 2>/dev/null || cat; }

command -v jq >/dev/null || { echo "jq is required: apt install jq"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# 0. App identity. /auth/guest needs a real UUID in X-Device-Id — it is the
#    installation identity, and the schema rejects anything that is not a v1-v5 UUID.
# ─────────────────────────────────────────────────────────────────────────────
DEVICE_ID="$(uuidgen)"
APP_HEADERS=(
  -H "X-App-Version: 1.0.0"
  -H "X-Device-Id: ${DEVICE_ID}"
  -H "Accept-Language: en"
)

hr "0. Create a guest user and take its access token"
AUTH_JSON="$(curl -sS -X POST "${BASE_URL}/auth/guest" \
  "${APP_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d '{"device":{"model":"Pixel 8","os":"Android 14"}}')"
echo "$AUTH_JSON" | jqp

ACCESS_TOKEN="$(echo "$AUTH_JSON" | jq -er '.access')"
USER_ID="$(echo "$AUTH_JSON" | jq -r '.user.id // "?"')"
echo "user_id=${USER_ID}"

AUTH_HEADERS=("${APP_HEADERS[@]}" -H "Authorization: Bearer ${ACCESS_TOKEN}")

# ─────────────────────────────────────────────────────────────────────────────
# 1. The feature ships off. Prove it before turning it on.
# ─────────────────────────────────────────────────────────────────────────────
hr "1. GET /earning/coin/state  (expect enabled:false on a fresh database)"
curl -sS "${BASE_URL}/earning/coin/state" "${AUTH_HEADERS[@]}" | jqp

hr "2. POST /earning/coin while disabled  (expect 404 FEATURE_DISABLED)"
curl -sS -w '\nHTTP %{http_code}\n' -X POST "${BASE_URL}/earning/coin" \
  "${AUTH_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d '{"amount_coin":250}' | jqp

# ─────────────────────────────────────────────────────────────────────────────
# 2. Flip the switch as a superadmin.
#
#    Two auth paths exist. The session path below is the real one. If you have
#    ENABLE_LEGACY_ADMIN_API_KEY=true in your env you can skip the login and use:
#
#      -H "X-Admin-Api-Key: ${ADMIN_API_KEY}" \
#      -H "X-Admin-User-Id: <a superadmin admin_users.id>" \
#      -H "X-Csrf-Token: ${ADMIN_CSRF_TOKEN}"
# ─────────────────────────────────────────────────────────────────────────────
if [[ -z "$CMS_PASSWORD" ]]; then
  hr "3. SKIPPED — set CMS_PASSWORD (and CMS_EMAIL) to a superadmin to continue"
  echo "The remaining steps need the feature enabled. Re-run with:"
  echo "  CMS_EMAIL=<superadmin email> CMS_PASSWORD=<password> $0"
  exit 0
fi

hr "3. POST /admin/session  (superadmin login, stores the cookie)"
SESSION_JSON="$(curl -sS -c "$COOKIE_JAR" -X POST "${BASE_URL}/admin/session" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg e "$CMS_EMAIL" --arg p "$CMS_PASSWORD" '{email:$e,password:$p}')")"
echo "$SESSION_JSON" | jqp
CSRF_TOKEN="$(echo "$SESSION_JSON" | jq -er '.csrf_token')"

hr "4. PUT /admin/direct-coin-settings  (enable, ceiling ${MAX_AMOUNT_COIN})"
curl -sS -b "$COOKIE_JAR" -X PUT "${BASE_URL}/admin/direct-coin-settings" \
  -H "Content-Type: application/json" \
  -H "X-Csrf-Token: ${CSRF_TOKEN}" \
  -d "$(jq -nc --argjson m "$MAX_AMOUNT_COIN" '{enabled:true,max_amount_coin:$m}')" | jqp

hr "5. GET /admin/direct-coin-settings  (read it back)"
curl -sS -b "$COOKIE_JAR" "${BASE_URL}/admin/direct-coin-settings" | jqp

# ─────────────────────────────────────────────────────────────────────────────
# 3. The actual feature.
# ─────────────────────────────────────────────────────────────────────────────
hr "6. GET /earning/coin/state  (expect enabled:true now)"
curl -sS "${BASE_URL}/earning/coin/state" "${AUTH_HEADERS[@]}" | jqp

hr "7. POST /earning/coin  — the minimal call mobile makes"
curl -sS -w '\nHTTP %{http_code}\n' -X POST "${BASE_URL}/earning/coin" \
  "${AUTH_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d '{"amount_coin":250}' | jqp

IDEM_KEY="demo-$(uuidgen)"
hr "8. POST /earning/coin with an idempotency key  (first call: deduped:false)"
curl -sS -X POST "${BASE_URL}/earning/coin" \
  "${AUTH_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg k "$IDEM_KEY" '{amount_coin:100,idempotency_key:$k}')" | jqp

hr "9. Same key again  (expect deduped:true, amount_coin:0, balance unchanged)"
curl -sS -X POST "${BASE_URL}/earning/coin" \
  "${AUTH_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg k "$IDEM_KEY" '{amount_coin:100,idempotency_key:$k}')" | jqp

hr "10. Over the ceiling  (expect 400 AMOUNT_TOO_LARGE)"
curl -sS -w '\nHTTP %{http_code}\n' -X POST "${BASE_URL}/earning/coin" \
  "${AUTH_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --argjson m "$((MAX_AMOUNT_COIN + 1))" '{amount_coin:$m}')" | jqp

hr "11. Wallet balance"
curl -sS "${BASE_URL}/wallet" "${AUTH_HEADERS[@]}" | jqp

hr "12. Turn the feature back off"
curl -sS -b "$COOKIE_JAR" -X PUT "${BASE_URL}/admin/direct-coin-settings" \
  -H "Content-Type: application/json" \
  -H "X-Csrf-Token: ${CSRF_TOKEN}" \
  -d "$(jq -nc --argjson m "$MAX_AMOUNT_COIN" '{enabled:false,max_amount_coin:$m}')" | jqp

printf '\n\033[1mDone.\033[0m Rate limit is 5 grants/60s per user — re-running immediately will 429.\n'
