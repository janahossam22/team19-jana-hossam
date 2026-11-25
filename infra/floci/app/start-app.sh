#!/usr/bin/env bash
# =====================================================================
# Team 19 - run our API in the AWS version (Floci) - Jana Hossam, issue #43
#
# Run from the repo root, after Floci is up and Hana's setup.sh has run:
#   bash infra/floci/app/start-app.sh
#
#   1. Secrets Manager: creates team19/app with a random JWT_SECRET and
#      CRON_SECRET. The values are never printed or kept in a file.
#   2. IAM: lets team19-api read that one secret, nothing else.
#   3. Starts the API container as team19-api, with the role's temporary
#      keys (1 hour). The database is reached with IAM tokens, so no
#      database password exists anywhere.
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
STATE="${FLOCI_STATE_DIR:-$ROOT/infra/floci/.state}"
# shellcheck disable=SC1091
source "$STATE/env"   # ids from setup.sh (no passwords)

# Floci's bootstrap credential, used only to build things (as in setup.sh)
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_PAGER=""

SECRET_NAME="team19/app"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml" --profile app)

log() { printf '\n==> %s\n' "$*"; }

# ---------------------------------------------------------------------
log "1/3 Secret $SECRET_NAME (JWT_SECRET, CRON_SECRET)"
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  echo "Already there - kept"
else
  rand() { openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 48; }
  TMP="$(mktemp)"            # readable only by this user
  trap 'rm -f "$TMP"' EXIT   # removed even if a step fails
  jq -n --arg jwt "$(rand)" --arg cron "$(rand)" \
     '{JWT_SECRET: $jwt, CRON_SECRET: $cron}' > "$TMP"
  aws secretsmanager create-secret --name "$SECRET_NAME" \
    --description "Team 19 API: login-token key and daily-job key" \
    --secret-string "file://$TMP" \
    --tags Key=project,Value=team19 Key=owner,Value=jana-hossam >/dev/null
  rm -f "$TMP"
  echo "Created (random values, never shown)"
fi

# ---------------------------------------------------------------------
log "2/3 team19-api may read $SECRET_NAME (and no other secret)"
POLICY="$(sed -e "s/\${ACCOUNT_ID}/$ACCOUNT_ID/g" -e "s/\${REGION}/$REGION/g" "$HERE/api-secret-policy.json")"
aws iam put-role-policy --role-name team19-api --policy-name team19-api-app-secret \
  --policy-document "$POLICY"
echo "team19-api  <- api-secret-policy.json"

# ---------------------------------------------------------------------
log "3/3 Start the API as team19-api"
CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT_ID:role/team19-api" \
          --role-session-name team19-api-app --duration-seconds 3600 \
          --query Credentials --output json)"
# Only this command gets the role's keys; they are not saved anywhere.
API_KEY_ID="$(jq -r .AccessKeyId <<<"$CREDS")" \
API_SECRET_KEY="$(jq -r .SecretAccessKey <<<"$CREDS")" \
API_SESSION_TOKEN="$(jq -r .SessionToken <<<"$CREDS")" \
REGION="$REGION" DB_PORT="$DB_PORT" DB_NAME="$DB_NAME" \
  "${COMPOSE[@]}" up -d --build api
unset CREDS

echo "Waiting for the API..."
for i in $(seq 1 60); do
  if curl -fsS http://localhost:3000/api/health >/dev/null 2>&1; then
    echo "API is up on http://localhost:3000"
    exit 0
  fi
  # Stop early if the container quit (for example a missing secret)
  if [ "$(docker inspect -f '{{.State.Running}}' team19-api 2>/dev/null)" = "false" ]; then
    break
  fi
  sleep 2
done
echo "The API did not start. Its log:"
docker logs team19-api 2>&1 | tail -n 30
exit 1
