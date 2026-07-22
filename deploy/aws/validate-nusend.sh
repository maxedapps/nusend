#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

MODE="final"
case "${1:-}" in
  "") ;;
  --pre-simulator) MODE="pre-simulator" ;;
  --help)
    cat <<'EOF'
Usage: deploy/aws/validate-nusend.sh [--pre-simulator]

Runs API-backed readiness through the built and authenticated Nusend CLI.
--pre-simulator checks configuration and AWS access before live sends. Default
final mode additionally requires observed feedback and protected bounce and
complaint suppressions. No local AWS credentials or Docker access are needed.
EOF
    exit 0
    ;;
  *) fail "Unknown argument: $1" ;;
esac
[[ $# -le 1 ]] || fail "Only one mode may be supplied."

for command in jq mktemp; do
  command -v "$command" >/dev/null 2>&1 || fail "Missing required command: $command"
done
SETUP_CONFIG_FILE="${NUSEND_AWS_SETUP_CONFIG:-$REPO_ROOT/.env.aws-setup}"
[[ -f "$SETUP_CONFIG_FILE" ]] || fail "Missing $SETUP_CONFIG_FILE. Provide the same setup config used for provisioning."
# shellcheck disable=SC1090
source "$SETUP_CONFIG_FILE"
[[ "${ENABLE_MARKETING:-}" == "true" || "${ENABLE_MARKETING:-}" == "false" ]] || fail "ENABLE_MARKETING must be true or false."

CLI="${NUSEND_CLI_BIN:-$REPO_ROOT/apps/cli/dist/main.js}"
[[ -x "$CLI" ]] || fail "Missing executable CLI at $CLI. Run pnpm --filter @nusend/cli build and authenticate it first."

TEMP_ROOT="${TMPDIR:-/tmp}"
WORK_DIR="$(mktemp -d "${TEMP_ROOT%/}/nusend-validation.XXXXXX")"
chmod 700 "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

BASE_REQUIRED_READINESS_IDS_JSON='[
  "config.aws_region",
  "config.from_email",
  "config.configuration_set.transactional",
  "config.feedback_topics",
  "db.ses_operations_schema",
  "aws.credentials_and_account",
  "ses.account.production_access",
  "ses.account.sending_enabled",
  "ses.account.enforcement_status",
  "ses.account.suppression_recommendation",
  "ses.identity.from_email",
  "ses.identity.dkim",
  "ses.config_set.transactional.exists",
  "ses.config_set.transactional.events",
  "sns.topic.exists",
  "sns.topic.signature_version",
  "sns.subscription.webhook"
]'
if [[ "$ENABLE_MARKETING" == "true" ]]; then
  BASE_REQUIRED_READINESS_IDS_JSON="$(jq -c '. + [
    "config.configuration_set.marketing",
    "config.unsubscribe_secret",
    "ses.config_set.marketing.exists",
    "ses.config_set.marketing.events"
  ] | unique' <<<"$BASE_REQUIRED_READINESS_IDS_JSON")"
fi

assert_readiness() {
  local required_json="$1"
  "$CLI" --json ses readiness >"$WORK_DIR/nusend-ses-readiness.json"
  jq . "$WORK_DIR/nusend-ses-readiness.json"
  if ! jq -e --argjson required "$required_json" '
    ([.checks[] |
      select(.id as $id | $required | index($id)) |
      select(.status != "ok")] | length) == 0
  ' "$WORK_DIR/nusend-ses-readiness.json" >/dev/null; then
    jq --argjson required "$required_json" '
      [.checks[] |
       select(.id as $id | $required | index($id)) |
       select(.status != "ok")]
    ' "$WORK_DIR/nusend-ses-readiness.json" >&2
    fail "One or more required Nusend readiness checks are not ok. Run 'ses setup-guide'."
  fi
}

printf 'Validating Nusend readiness through %s\n' "$CLI"
if [[ "$MODE" == "pre-simulator" ]]; then
  assert_readiness "$BASE_REQUIRED_READINESS_IDS_JSON"
  printf '\nPre-simulator readiness passed. Live simulator and suppression gates remain incomplete.\n'
  exit 0
fi

FINAL_REQUIRED_READINESS_IDS_JSON="$(jq -c '. + ["operations.latest_feedback"] | unique' <<<"$BASE_REQUIRED_READINESS_IDS_JSON")"
assert_readiness "$FINAL_REQUIRED_READINESS_IDS_JSON"

"$CLI" --json suppressions list \
  --email bounce@simulator.amazonses.com --scope all --reason bounce \
  >"$WORK_DIR/bounce-suppressions.json"
"$CLI" --json suppressions list \
  --email complaint@simulator.amazonses.com --scope all --reason complaint \
  >"$WORK_DIR/complaint-suppressions.json"
jq -e '.items | any(.[]; .scope == "all" and .reason == "bounce")' \
  "$WORK_DIR/bounce-suppressions.json" >/dev/null || fail "Expected protected global bounce suppression was not found."
jq -e '.items | any(.[]; .scope == "all" and .reason == "complaint")' \
  "$WORK_DIR/complaint-suppressions.json" >/dev/null || fail "Expected protected global complaint suppression was not found."

printf '\nNusend readiness, observed feedback, and protected suppressions passed.\n'
