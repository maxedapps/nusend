#!/usr/bin/env bash

# Shared helpers for the Nusend AWS workflow scripts. Source this file; do not run it.

AWS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NUSEND_REPO_ROOT="$(cd "$AWS_SCRIPT_DIR/../.." && pwd)"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '\n==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "Missing setup value: $name"
}

require_boolean() {
  local name="$1"
  local value="${!name:-}"
  [[ "$value" == "true" || "$value" == "false" ]] || fail "$name must be true or false."
}

confirm_phrase() {
  local phrase="$1"
  local prompt="$2"
  local answer=""
  read -r -p "$prompt Type $phrase to continue: " answer
  [[ "$answer" == "$phrase" ]] || fail "Confirmation cancelled."
}

load_setup() {
  SETUP_CONFIG_FILE="${NUSEND_AWS_SETUP_CONFIG:-$NUSEND_REPO_ROOT/.env.aws-setup}"
  [[ -f "$SETUP_CONFIG_FILE" ]] || fail "Missing $SETUP_CONFIG_FILE. Copy deploy/aws/setup.conf.example and customize it first."

  # The operator owns this trusted local shell configuration file.
  # shellcheck disable=SC1090
  source "$SETUP_CONFIG_FILE"

  for command in aws jq curl dig; do
    require_command "$command"
  done
  [[ "$(aws --version 2>&1)" == aws-cli/2.* ]] || fail "AWS CLI v2 is required."

  for name in \
    AWS_PROFILE AWS_REGION NUSEND_DOMAIN SES_IDENTITY SES_FROM_EMAIL \
    SES_TRANSACTIONAL_SET SES_EVENT_DESTINATION_NAME SNS_TOPIC_NAME SNS_DLQ_NAME \
    RUNTIME_IAM_USER_NAME RUNTIME_IAM_POLICY_NAME ALARM_NAME_PREFIX \
    ENABLE_MARKETING ENABLE_DELIVERY_EVENTS TRACKING_EVENTS_JSON \
    SUBMIT_PRODUCTION_ACCESS_REQUEST; do
    require_value "$name"
  done

  require_boolean ENABLE_MARKETING
  require_boolean ENABLE_DELIVERY_EVENTS
  require_boolean SUBMIT_PRODUCTION_ACCESS_REQUEST

  SES_MARKETING_SET="${SES_MARKETING_SET:-}"
  ROUTE53_HOSTED_ZONE_ID="${ROUTE53_HOSTED_ZONE_ID:-}"
  ALARM_ACTION_ARN="${ALARM_ACTION_ARN:-}"
  ALARM_TOPIC_NAME="${ALARM_TOPIC_NAME:-}"
  OPS_ALERT_EMAIL="${OPS_ALERT_EMAIL:-}"

  [[ "$SES_IDENTITY" != *"@"* ]] || fail "SES_IDENTITY must be a domain, not an email address."
  [[ "$SES_IDENTITY" != *"/"* && "$SES_IDENTITY" != *"://"* ]] || fail "SES_IDENTITY must be a bare domain."
  [[ "${SES_FROM_EMAIL##*@}" == "$SES_IDENTITY" ]] || fail "SES_FROM_EMAIL must use the exact SES_IDENTITY domain."
  [[ "$NUSEND_DOMAIN" != *"/"* && "$NUSEND_DOMAIN" != *"://"* ]] || fail "NUSEND_DOMAIN must be a bare hostname."

  if [[ "$ENABLE_MARKETING" == "true" ]]; then
    require_value SES_MARKETING_SET
  fi

  jq -e '
    type == "array" and
    all(.[]; . == "OPEN" or . == "CLICK") and
    (length == (unique | length))
  ' <<<"$TRACKING_EVENTS_JSON" >/dev/null || fail 'TRACKING_EVENTS_JSON must be a unique JSON array containing only "OPEN" and/or "CLICK".'

  if [[ "$ENABLE_MARKETING" != "true" && "$TRACKING_EVENTS_JSON" != "[]" ]]; then
    fail "Tracking events require ENABLE_MARKETING=true."
  fi

  if [[ -z "$ALARM_ACTION_ARN" ]]; then
    [[ -n "$ALARM_TOPIC_NAME" && -n "$OPS_ALERT_EMAIL" ]] || fail "Set ALARM_ACTION_ARN or both ALARM_TOPIC_NAME and OPS_ALERT_EMAIL."
  fi

  if [[ "$SUBMIT_PRODUCTION_ACCESS_REQUEST" == "true" ]]; then
    SES_MAIL_TYPE="${SES_MAIL_TYPE:-}"
    [[ "$SES_MAIL_TYPE" == "MARKETING" || "$SES_MAIL_TYPE" == "TRANSACTIONAL" ]] || fail "SES_MAIL_TYPE must be MARKETING or TRANSACTIONAL."
    for name in SES_WEBSITE_URL SES_CONTACT_EMAIL SES_USE_CASE_DESCRIPTION; do
      require_value "$name"
    done
  fi

  export AWS_PROFILE AWS_REGION
  export AWS_PAGER=""

  CALLER_JSON="$(aws sts get-caller-identity --output json)"
  AWS_ACCOUNT_ID="$(jq -r '.Account' <<<"$CALLER_JSON")"
  CALLER_ARN="$(jq -r '.Arn' <<<"$CALLER_JSON")"
  AWS_PARTITION="$(cut -d: -f2 <<<"$CALLER_ARN")"
  [[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || fail "Could not determine a 12-digit AWS account ID."

  TEMP_ROOT="${TMPDIR:-/tmp}"
  WORK_DIR="${TEMP_ROOT%/}/nusend-aws-${AWS_ACCOUNT_ID}-${AWS_REGION}"
  mkdir -p "$WORK_DIR"
  chmod 700 "$WORK_DIR"

  SNS_TOPIC_ARN="arn:${AWS_PARTITION}:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:${SNS_TOPIC_NAME}"
  TRANSACTIONAL_SET_ARN="arn:${AWS_PARTITION}:ses:${AWS_REGION}:${AWS_ACCOUNT_ID}:configuration-set/${SES_TRANSACTIONAL_SET}"
  MARKETING_SET_ARN="arn:${AWS_PARTITION}:ses:${AWS_REGION}:${AWS_ACCOUNT_ID}:configuration-set/${SES_MARKETING_SET}"
  SNS_DLQ_ARN="arn:${AWS_PARTITION}:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${SNS_DLQ_NAME}"
  IDENTITY_EMAIL_ARN="arn:${AWS_PARTITION}:ses:${AWS_REGION}:${AWS_ACCOUNT_ID}:identity/${SES_FROM_EMAIL}"
  IDENTITY_DOMAIN_ARN="arn:${AWS_PARTITION}:ses:${AWS_REGION}:${AWS_ACCOUNT_ID}:identity/${SES_IDENTITY}"

  export SETUP_CONFIG_FILE NUSEND_REPO_ROOT WORK_DIR
  export AWS_ACCOUNT_ID CALLER_ARN AWS_PARTITION
  export SNS_TOPIC_ARN TRANSACTIONAL_SET_ARN MARKETING_SET_ARN SNS_DLQ_ARN
  export IDENTITY_EMAIL_ARN IDENTITY_DOMAIN_ARN
}

print_context() {
  printf 'Config: %s\nCaller: %s\nAccount: %s\nPartition: %s\nRegion: %s\nWork directory: %s\n' \
    "$SETUP_CONFIG_FILE" "$CALLER_ARN" "$AWS_ACCOUNT_ID" "$AWS_PARTITION" "$AWS_REGION" "$WORK_DIR"
}

load_dlq() {
  SNS_DLQ_URL="$(aws sqs get-queue-url \
    --queue-name "$SNS_DLQ_NAME" \
    --query 'QueueUrl' \
    --output text)"
  local actual_arn
  actual_arn="$(aws sqs get-queue-attributes \
    --queue-url "$SNS_DLQ_URL" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' \
    --output text)"
  [[ "$actual_arn" == "$SNS_DLQ_ARN" ]] || fail "Unexpected DLQ ARN: $actual_arn"
  export SNS_DLQ_URL
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  fail "Source deploy/aws/lib.sh from a Nusend AWS workflow script; do not run it directly."
fi
