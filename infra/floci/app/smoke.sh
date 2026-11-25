#!/usr/bin/env bash
# =====================================================================
# Team 19 - checks for the API in the AWS version (Floci) - Jana Hossam, issue #43
#
# Run after start-app.sh:  bash infra/floci/app/smoke.sh
# Each check is a real request to the running API container or to Floci.
# Writes infra/floci/.state/app-results.md (also shown on the GitHub
# Actions run page) and exits 1 if any check fails.
# =====================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
STATE="${FLOCI_STATE_DIR:-$ROOT/infra/floci/.state}"
# shellcheck disable=SC1091
source "$STATE/env"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_PAGER=""

API="http://localhost:3000/api"
SECRET_NAME="team19/app"
PASS=0
FAIL=0
ROWS=""

record() {  # ok|fail  label  detail
  local mark
  if [ "$1" = ok ]; then PASS=$((PASS + 1)); mark="PASS"; else FAIL=$((FAIL + 1)); mark="FAIL"; fi
  printf '%-5s %s%s\n' "$mark" "$2" "${3:+  ($3)}"
  local detail="${3:-}"
  ROWS+="| $mark | $2 | ${detail//|/\\|} |"$'\n'
}

# HTTP status of a request:  status METHOD PATH [extra curl args...]
status() {
  local method="$1" path="$2"; shift 2
  curl -s -o /dev/null -w '%{http_code}' -X "$method" "$API$path" "$@"
}

expect_status() {  # label wanted METHOD PATH [extra curl args...]
  local label="$1" want="$2"; shift 2
  local got; got="$(status "$@")"
  if [ "$got" = "$want" ]; then record ok "$label" "HTTP $got"; else record fail "$label" "expected $want, got $got"; fi
}

# Both secrets, read with the bootstrap (admin) credential only for this
# test. Masked in the GitHub log and never printed.
SECRET_JSON="$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" \
                --query SecretString --output text)"
CRON="$(jq -r .CRON_SECRET <<<"$SECRET_JSON")"
JWT="$(jq -r .JWT_SECRET <<<"$SECRET_JSON")"
unset SECRET_JSON
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$CRON"; echo "::add-mask::$JWT"; fi

# ---------------------------------------------------------------------
echo "## 1. The API runs and uses the database with IAM tokens"
expect_status "Health check" 200 GET /health
# A wrong login reads and writes the database as app_rw (login_attempts,
# audit_log). A database or IAM error would give 500, not 401.
expect_status "Wrong login -> 401 (app_rw logs in with an IAM token)" 401 POST /auth/login \
  -H 'Content-Type: application/json' --data '{"email":"nobody@example.com","password":"wrong-password"}'
expect_status "Dashboard without a token -> 401" 401 GET /dashboard/summary

echo "## 2. Secrets come from Secrets Manager"
expect_status "Daily job without the secret -> 401" 401 GET /jobs/notifications
expect_status "Daily job with a wrong secret -> 401" 401 GET /jobs/notifications \
  -H "Authorization: Bearer wrong-secret-wrong-secret-wrong-secret"
# 200 proves two things: the API loaded CRON_SECRET from Secrets Manager,
# and the job's pool logged in as notifier with an IAM token.
expect_status "Daily job with CRON_SECRET from Secrets Manager -> 200 (notifier pool)" 200 GET /jobs/notifications \
  -H "Authorization: Bearer $CRON"

echo "## 3. Least privilege for the secret"
as_role() {  # role cmd...
  local role="$1" creds; shift
  creds="$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$role" \
            --role-session-name "check-$role" --query Credentials --output json)" || return 1
  AWS_ACCESS_KEY_ID="$(jq -r .AccessKeyId <<<"$creds")" \
  AWS_SECRET_ACCESS_KEY="$(jq -r .SecretAccessKey <<<"$creds")" \
  AWS_SESSION_TOKEN="$(jq -r .SessionToken <<<"$creds")" "$@"
}
can_read() { as_role "$1" aws secretsmanager get-secret-value --secret-id "$2" --query Name --output text >/dev/null 2>&1; }

if can_read team19-api "$SECRET_NAME"; then record ok "team19-api can read $SECRET_NAME"; else record fail "team19-api can read $SECRET_NAME"; fi
if can_read team19-api "$SECRET_ARN"; then record fail "team19-api cannot read the RDS master password" "it could"; else record ok "team19-api cannot read the RDS master password"; fi
if can_read team19-dashboard "$SECRET_NAME"; then record fail "team19-dashboard cannot read $SECRET_NAME" "it could"; else record ok "team19-dashboard cannot read $SECRET_NAME"; fi
if can_read team19-notifier "$SECRET_NAME"; then record fail "team19-notifier cannot read $SECRET_NAME" "it could"; else record ok "team19-notifier cannot read $SECRET_NAME"; fi

echo "## 4. The container"
LOGS="$(docker logs team19-api 2>&1)"
if grep -qF -e "$CRON" -e "$JWT" <<<"$LOGS"; then record fail "Secrets never appear in the API log"; else record ok "Secrets never appear in the API log" "JWT_SECRET and CRON_SECRET"; fi
UID_IN="$(docker exec team19-api id -u 2>&1)"
if [ "$UID_IN" != "0" ] && [ -n "$UID_IN" ]; then record ok "API runs as a normal user, not root" "uid $UID_IN"; else record fail "API runs as a normal user, not root" "uid $UID_IN"; fi
# /home/node belongs to the node user, so only read_only: true can stop this write.
RO="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' team19-api 2>&1)"
if [ "$RO" = "true" ] && ! docker exec team19-api sh -c 'echo x > /home/node/test' >/dev/null 2>&1; then
  record ok "Container files are read-only" "even the node user's own folder"
else
  record fail "Container files are read-only" "ReadonlyRootfs=$RO"
fi
ENV_DUMP="$(docker exec team19-api env 2>&1)"
if grep -qE '^(JWT_SECRET|CRON_SECRET)=' <<<"$ENV_DUMP"; then record fail "Secrets are not in the container settings"; else record ok "Secrets are not in the container settings" "only loaded in memory"; fi
if grep -qE '^(DATABASE_URL|DASHBOARD_DATABASE_URL|NOTIFIER_DATABASE_URL)=postgresql://[^@/]*:[^@]*@' <<<"$ENV_DUMP"; then
  record fail "Database URLs have no password"
else
  record ok "Database URLs have no password" "IAM tokens only"
fi
unset CRON JWT LOGS ENV_DUMP

# ---------------------------------------------------------------------
TOTAL=$((PASS + FAIL))
{
  echo "# Floci: the API in the AWS version (Jana Hossam, #43)"
  echo
  echo "**$PASS of $TOTAL checks passed, $FAIL failed.**"
  echo
  echo "| Result | Check | Detail |"
  echo "|---|---|---|"
  printf '%s' "$ROWS"
} > "$STATE/app-results.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$STATE/app-results.md" >> "$GITHUB_STEP_SUMMARY"

printf '\n%s of %s checks passed, %s failed.\n' "$PASS" "$TOTAL" "$FAIL"
[ "$FAIL" -eq 0 ]
