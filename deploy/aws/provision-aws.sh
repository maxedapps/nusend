#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/aws/lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
Usage: deploy/aws/provision-aws.sh <command>

Commands:
  preflight  Validate tools, configuration, caller, region, and resource names
  ses        Provision SES identity, DKIM, suppression, and configuration sets
  feedback   Provision SNS feedback, SES event destinations, and the SQS DLQ
  iam        Provision the runtime IAM user, policy, and optional one-time key

Run commands individually in this order. Each command is safely rerunnable where
AWS permits and preserves all explicit DNS, approval, policy, and secret gates.
EOF
}

run_preflight() {
load_setup
info "Provisioning context"
print_context

cat <<EOF
SES identity: $SES_IDENTITY
SES From address: $SES_FROM_EMAIL
Transactional configuration set: $SES_TRANSACTIONAL_SET
Marketing enabled: $ENABLE_MARKETING
Feedback topic: $SNS_TOPIC_ARN
Feedback DLQ: $SNS_DLQ_ARN
Runtime IAM user: $RUNTIME_IAM_USER_NAME
Public webhook: https://${NUSEND_DOMAIN}/api/webhooks/aws/sns/ses
EOF

printf '\nVerify the caller, account, partition, region, names, and public domain before continuing.\n'
}

run_ses() {
load_setup
info "Provisioning context"
print_context

info "Create or reuse the SES domain identity"
IDENTITIES_JSON="$(aws sesv2 list-email-identities --output json)"
if jq -e --arg identity "$SES_IDENTITY" \
  'any(.EmailIdentities[]?; .IdentityName == $identity)' \
  <<<"$IDENTITIES_JSON" >/dev/null; then
  printf 'Reusing SES identity: %s\n' "$SES_IDENTITY"
else
  aws sesv2 create-email-identity \
    --email-identity "$SES_IDENTITY" \
    --tags \
      Key=nusend:managed-by,Value=aws-cli-runbook \
      Key=nusend:environment,Value=production \
    >"$WORK_DIR/create-email-identity.json"
  printf 'Created SES identity: %s\n' "$SES_IDENTITY"
fi

IDENTITY_JSON="$(aws sesv2 get-email-identity \
  --email-identity "$SES_IDENTITY" \
  --output json)"
printf '%s\n' "$IDENTITY_JSON" >"$WORK_DIR/email-identity.json"

DKIM_TOKENS_JSON="$(jq -c '.DkimAttributes.Tokens // []' <<<"$IDENTITY_JSON")"
DKIM_TOKEN_COUNT="$(jq 'length' <<<"$DKIM_TOKENS_JSON")"
DKIM_SIGNING_ZONE="$(jq -r '.DkimAttributes.SigningHostedZone // "dkim.amazonses.com"' <<<"$IDENTITY_JSON")"
DKIM_SIGNING_ZONE="${DKIM_SIGNING_ZONE%.}"
[[ "$DKIM_TOKEN_COUNT" -gt 0 ]] || fail "SES did not return Easy DKIM tokens. Inspect $WORK_DIR/email-identity.json."

jq -r --arg domain "$SES_IDENTITY" --arg targetZone "$DKIM_SIGNING_ZONE" '
  .[] |
  "CNAME\t" + . + "._domainkey." + $domain +
  "\t" + . + "." + $targetZone
' <<<"$DKIM_TOKENS_JSON" | tee "$WORK_DIR/dkim-records.tsv"

if [[ -n "$ROUTE53_HOSTED_ZONE_ID" ]]; then
  info "Prepare Route 53 Easy DKIM UPSERT"
  HOSTED_ZONE_JSON="$(aws route53 get-hosted-zone --id "$ROUTE53_HOSTED_ZONE_ID")"
  HOSTED_ZONE_NAME="$(jq -r '.HostedZone.Name | rtrimstr(".")' <<<"$HOSTED_ZONE_JSON")"
  [[ "$HOSTED_ZONE_NAME" == "$SES_IDENTITY" ]] || fail "Hosted zone $HOSTED_ZONE_NAME does not exactly match SES_IDENTITY $SES_IDENTITY."

  jq -n \
    --arg domain "$SES_IDENTITY" \
    --arg targetZone "$DKIM_SIGNING_ZONE" \
    --argjson tokens "$DKIM_TOKENS_JSON" '
    {
      Comment: "Nusend SES Easy DKIM",
      Changes: [
        $tokens[] as $token |
        {
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: ($token + "._domainkey." + $domain),
            Type: "CNAME",
            TTL: 300,
            ResourceRecords: [{Value: ($token + "." + $targetZone)}]
          }
        }
      ]
    }
  ' >"$WORK_DIR/route53-dkim-change.json"

  jq . "$WORK_DIR/route53-dkim-change.json"
  confirm_phrase APPLY-DKIM "Review the exact hosted zone and records."
  aws route53 change-resource-record-sets \
    --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
    --change-batch "file://$WORK_DIR/route53-dkim-change.json"
else
  printf '\nManual DNS action required: publish every record in %s at the authoritative provider.\n' "$WORK_DIR/dkim-records.tsv"
fi

info "Configure SES account suppression"
aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT
aws sesv2 get-account \
  --query '{SuppressedReasons:SuppressionAttributes.SuppressedReasons}' \
  --output json

info "Inspect or request SES production access"
ACCOUNT_JSON="$(aws sesv2 get-account --output json)"
PRODUCTION_ACCESS_ENABLED="$(jq -r '.ProductionAccessEnabled' <<<"$ACCOUNT_JSON")"
PRODUCTION_REVIEW_STATUS="$(jq -r '.Details.ReviewDetails.Status // "NONE"' <<<"$ACCOUNT_JSON")"
printf 'SES production access in %s: %s (review: %s)\n' \
  "$AWS_REGION" "$PRODUCTION_ACCESS_ENABLED" "$PRODUCTION_REVIEW_STATUS"

if [[ "$PRODUCTION_ACCESS_ENABLED" == "false" && \
      "$PRODUCTION_REVIEW_STATUS" != "PENDING" && \
      "$SUBMIT_PRODUCTION_ACCESS_REQUEST" == "true" ]]; then
  printf 'Mail type: %s\nWebsite: %s\nContact: %s\nUse case: %s\n' \
    "$SES_MAIL_TYPE" "$SES_WEBSITE_URL" "$SES_CONTACT_EMAIL" "$SES_USE_CASE_DESCRIPTION"
  confirm_phrase REQUEST-PRODUCTION-ACCESS "Review the production-access request above."
  aws sesv2 put-account-details \
    --production-access-enabled \
    --mail-type "$SES_MAIL_TYPE" \
    --website-url "$SES_WEBSITE_URL" \
    --contact-language EN \
    --use-case-description "$SES_USE_CASE_DESCRIPTION" \
    --additional-contact-email-addresses "$SES_CONTACT_EMAIL"
  printf 'Request submitted. Immediately reset SUBMIT_PRODUCTION_ACCESS_REQUEST=false.\n'
fi

ensure_configuration_set() {
  local name="$1"
  local sets
  sets="$(aws sesv2 list-configuration-sets --output json)"
  if jq -e --arg name "$name" '(.ConfigurationSets // []) | index($name) != null' <<<"$sets" >/dev/null; then
    printf 'Reusing configuration set: %s\n' "$name"
  else
    aws sesv2 create-configuration-set \
      --configuration-set-name "$name" \
      --tags \
        Key=nusend:managed-by,Value=aws-cli-runbook \
        Key=nusend:environment,Value=production
    printf 'Created configuration set: %s\n' "$name"
  fi
  aws sesv2 put-configuration-set-sending-options \
    --configuration-set-name "$name" \
    --sending-enabled
}

info "Create or reuse SES configuration sets"
ensure_configuration_set "$SES_TRANSACTIONAL_SET"
if [[ "$ENABLE_MARKETING" == "true" ]]; then
  ensure_configuration_set "$SES_MARKETING_SET"
fi

info "Current SES identity status"
STATUS_JSON="$(aws sesv2 get-email-identity --email-identity "$SES_IDENTITY" --output json)"
jq '{
  VerificationStatus,
  VerifiedForSendingStatus,
  DkimStatus: .DkimAttributes.Status,
  DkimSigningEnabled: .DkimAttributes.SigningEnabled
}' <<<"$STATUS_JSON"

TOKEN="$(jq -r '.[0]' <<<"$DKIM_TOKENS_JSON")"
printf 'Authoritative CNAME lookup for the first token:\n'
dig +short CNAME "${TOKEN}._domainkey.${SES_IDENTITY}"

if ! jq -e '
  .VerificationStatus == "SUCCESS" and
  .VerifiedForSendingStatus == true and
  .DkimAttributes.SigningEnabled == true and
  .DkimAttributes.Status == "SUCCESS"
' <<<"$STATUS_JSON" >/dev/null; then
  printf '\nIdentity/DKIM is not ready yet. Publish DNS and rerun this script after propagation; do not recreate the identity.\n' >&2
else
  printf '\nSES identity and DKIM checks are ready.\n'
fi
}

run_feedback() {
load_setup
info "Provisioning context"
print_context

info "Verify SES configuration sets exist"
CONFIGURATION_SETS_JSON="$(aws sesv2 list-configuration-sets --output json)"
jq -e --arg name "$SES_TRANSACTIONAL_SET" \
  '(.ConfigurationSets // []) | index($name) != null' \
  <<<"$CONFIGURATION_SETS_JSON" >/dev/null || fail "Missing transactional configuration set. Run 'deploy/aws/provision-aws.sh ses' first."
if [[ "$ENABLE_MARKETING" == "true" ]]; then
  jq -e --arg name "$SES_MARKETING_SET" \
    '(.ConfigurationSets // []) | index($name) != null' \
    <<<"$CONFIGURATION_SETS_JSON" >/dev/null || fail "Missing marketing configuration set. Run 'deploy/aws/provision-aws.sh ses' first."
fi

info "Create or reuse the Standard SNS feedback topic"
ACTUAL_TOPIC_ARN="$(aws sns create-topic \
  --name "$SNS_TOPIC_NAME" \
  --tags \
    Key=nusend:managed-by,Value=aws-cli-runbook \
    Key=nusend:environment,Value=production \
  --query 'TopicArn' \
  --output text)"
[[ "$ACTUAL_TOPIC_ARN" == "$SNS_TOPIC_ARN" ]] || fail "Unexpected topic ARN: $ACTUAL_TOPIC_ARN"
aws sns set-topic-attributes \
  --topic-arn "$SNS_TOPIC_ARN" \
  --attribute-name SignatureVersion \
  --attribute-value 2

if [[ "$ENABLE_MARKETING" == "true" ]]; then
  SES_SOURCE_ARNS_JSON="$(jq -cn \
    --arg transactional "$TRANSACTIONAL_SET_ARN" \
    --arg marketing "$MARKETING_SET_ARN" \
    '[$transactional, $marketing]')"
else
  SES_SOURCE_ARNS_JSON="$(jq -cn --arg transactional "$TRANSACTIONAL_SET_ARN" '[$transactional]')"
fi

jq -n \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg topic "$SNS_TOPIC_ARN" \
  --argjson sources "$SES_SOURCE_ARNS_JSON" '
  {
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowSesConfigurationSets",
      Effect: "Allow",
      Principal: {Service: "ses.amazonaws.com"},
      Action: "sns:Publish",
      Resource: $topic,
      Condition: {
        StringEquals: {"aws:SourceAccount": $account},
        ArnEquals: {"aws:SourceArn": $sources}
      }
    }]
  }
' >"$WORK_DIR/sns-topic-policy.json"
jq empty "$WORK_DIR/sns-topic-policy.json"

CURRENT_TOPIC_POLICY="$(aws sns get-topic-attributes \
  --topic-arn "$SNS_TOPIC_ARN" \
  --query 'Attributes.Policy' \
  --output text)"
PROPOSED_TOPIC_POLICY="$(jq -S -c . "$WORK_DIR/sns-topic-policy.json")"
CURRENT_TOPIC_POLICY_CANONICAL=""
if [[ "$CURRENT_TOPIC_POLICY" != "None" && -n "$CURRENT_TOPIC_POLICY" ]]; then
  CURRENT_TOPIC_POLICY_CANONICAL="$(jq -S -c . <<<"$CURRENT_TOPIC_POLICY")"
fi

if [[ "$CURRENT_TOPIC_POLICY_CANONICAL" == "$PROPOSED_TOPIC_POLICY" ]]; then
  printf 'SNS topic policy already matches.\n'
else
  printf 'Current SNS topic policy:\n'
  if [[ -n "$CURRENT_TOPIC_POLICY_CANONICAL" ]]; then jq . <<<"$CURRENT_TOPIC_POLICY"; else printf '<none>\n'; fi
  printf 'Proposed dedicated topic policy:\n'
  jq . "$WORK_DIR/sns-topic-policy.json"
  confirm_phrase APPLY-SNS-POLICY "This replaces the dedicated topic policy."
  aws sns set-topic-attributes \
    --topic-arn "$SNS_TOPIC_ARN" \
    --attribute-name Policy \
    --attribute-value "file://$WORK_DIR/sns-topic-policy.json"
fi

info "Create or update SES event destinations"
BASE_EVENTS_JSON='["BOUNCE","COMPLAINT","REJECT","DELIVERY_DELAY"]'
if [[ "$ENABLE_DELIVERY_EVENTS" == "true" ]]; then
  BASE_EVENTS_JSON="$(jq -c '. + ["DELIVERY"] | unique' <<<"$BASE_EVENTS_JSON")"
fi
MARKETING_EVENTS_JSON="$(jq -cn \
  --argjson base "$BASE_EVENTS_JSON" \
  --argjson tracking "$TRACKING_EVENTS_JSON" \
  '$base + $tracking | unique')"

jq -n --arg topic "$SNS_TOPIC_ARN" --argjson events "$BASE_EVENTS_JSON" '
  {Enabled: true, MatchingEventTypes: $events, SnsDestination: {TopicArn: $topic}}
' >"$WORK_DIR/transactional-events.json"
jq -n --arg topic "$SNS_TOPIC_ARN" --argjson events "$MARKETING_EVENTS_JSON" '
  {Enabled: true, MatchingEventTypes: $events, SnsDestination: {TopicArn: $topic}}
' >"$WORK_DIR/marketing-events.json"

ensure_event_destination() {
  local set_name="$1"
  local event_file="$2"
  local destinations
  destinations="$(aws sesv2 get-configuration-set-event-destinations \
    --configuration-set-name "$set_name" \
    --output json)"
  if jq -e --arg name "$SES_EVENT_DESTINATION_NAME" \
    'any(.EventDestinations[]?; .Name == $name)' <<<"$destinations" >/dev/null; then
    aws sesv2 update-configuration-set-event-destination \
      --configuration-set-name "$set_name" \
      --event-destination-name "$SES_EVENT_DESTINATION_NAME" \
      --event-destination "file://$event_file"
    printf 'Updated event destination on %s.\n' "$set_name"
  else
    aws sesv2 create-configuration-set-event-destination \
      --configuration-set-name "$set_name" \
      --event-destination-name "$SES_EVENT_DESTINATION_NAME" \
      --event-destination "file://$event_file"
    printf 'Created event destination on %s.\n' "$set_name"
  fi
}

ensure_event_destination "$SES_TRANSACTIONAL_SET" "$WORK_DIR/transactional-events.json"
if [[ "$ENABLE_MARKETING" == "true" ]]; then
  ensure_event_destination "$SES_MARKETING_SET" "$WORK_DIR/marketing-events.json"
fi

info "Create or reuse the SQS feedback DLQ"
if aws sqs get-queue-url \
  --queue-name "$SNS_DLQ_NAME" \
  --query 'QueueUrl' \
  --output text \
  >"$WORK_DIR/dlq-url.txt" 2>"$WORK_DIR/get-dlq.err"; then
  SNS_DLQ_URL="$(cat "$WORK_DIR/dlq-url.txt")"
  printf 'Reusing DLQ: %s\n' "$SNS_DLQ_URL"
elif grep -Eq 'NonExistentQueue|QueueDoesNotExist' "$WORK_DIR/get-dlq.err"; then
  SNS_DLQ_URL="$(aws sqs create-queue \
    --queue-name "$SNS_DLQ_NAME" \
    --attributes '{"MessageRetentionPeriod":"1209600","SqsManagedSseEnabled":"true"}' \
    --tags '{"nusend:managed-by":"aws-cli-runbook","nusend:environment":"production"}' \
    --query 'QueueUrl' \
    --output text)"
  sleep 2
  printf 'Created DLQ: %s\n' "$SNS_DLQ_URL"
else
  cat "$WORK_DIR/get-dlq.err" >&2
  fail "Could not inspect the DLQ."
fi

aws sqs set-queue-attributes \
  --queue-url "$SNS_DLQ_URL" \
  --attributes '{"MessageRetentionPeriod":"1209600","SqsManagedSseEnabled":"true"}'
ACTUAL_DLQ_ARN="$(aws sqs get-queue-attributes \
  --queue-url "$SNS_DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"
[[ "$ACTUAL_DLQ_ARN" == "$SNS_DLQ_ARN" ]] || fail "Unexpected DLQ ARN: $ACTUAL_DLQ_ARN"

jq -n \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg queue "$SNS_DLQ_ARN" \
  --arg topic "$SNS_TOPIC_ARN" '
  {
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowSnsSubscriptionRedrive",
      Effect: "Allow",
      Principal: {Service: "sns.amazonaws.com"},
      Action: "sqs:SendMessage",
      Resource: $queue,
      Condition: {
        StringEquals: {"aws:SourceAccount": $account},
        ArnEquals: {"aws:SourceArn": $topic}
      }
    }]
  }
' >"$WORK_DIR/sqs-dlq-policy.json"
jq empty "$WORK_DIR/sqs-dlq-policy.json"

CURRENT_QUEUE_POLICY="$(aws sqs get-queue-attributes \
  --queue-url "$SNS_DLQ_URL" \
  --attribute-names Policy \
  --query 'Attributes.Policy' \
  --output text)"
PROPOSED_QUEUE_POLICY="$(jq -S -c . "$WORK_DIR/sqs-dlq-policy.json")"
CURRENT_QUEUE_POLICY_CANONICAL=""
if [[ "$CURRENT_QUEUE_POLICY" != "None" && -n "$CURRENT_QUEUE_POLICY" ]]; then
  CURRENT_QUEUE_POLICY_CANONICAL="$(jq -S -c . <<<"$CURRENT_QUEUE_POLICY")"
fi

if [[ "$CURRENT_QUEUE_POLICY_CANONICAL" == "$PROPOSED_QUEUE_POLICY" ]]; then
  printf 'SQS queue policy already matches.\n'
else
  printf 'Current SQS queue policy:\n'
  if [[ -n "$CURRENT_QUEUE_POLICY_CANONICAL" ]]; then jq . <<<"$CURRENT_QUEUE_POLICY"; else printf '<none>\n'; fi
  printf 'Proposed dedicated queue policy:\n'
  jq . "$WORK_DIR/sqs-dlq-policy.json"
  confirm_phrase APPLY-SQS-POLICY "This replaces the dedicated queue policy."
  SQS_ATTRIBUTES="$(jq -cn --rawfile policy "$WORK_DIR/sqs-dlq-policy.json" '{Policy:$policy}')"
  aws sqs set-queue-attributes \
    --queue-url "$SNS_DLQ_URL" \
    --attributes "$SQS_ATTRIBUTES"
fi

cat <<EOF

Feedback infrastructure ready:
SNS topic: $SNS_TOPIC_ARN
SQS DLQ URL: $SNS_DLQ_URL
SQS DLQ ARN: $SNS_DLQ_ARN
EOF
}

run_iam() {
load_setup
info "Provisioning context"
print_context

# Verify feedback infrastructure before granting runtime access to it.
ACTUAL_TOPIC_ARN="$(aws sns get-topic-attributes \
  --topic-arn "$SNS_TOPIC_ARN" \
  --query 'Attributes.TopicArn' \
  --output text)"
[[ "$ACTUAL_TOPIC_ARN" == "$SNS_TOPIC_ARN" ]] || fail "Feedback topic is missing or unexpected. Run 'deploy/aws/provision-aws.sh feedback' first."

if [[ "$ENABLE_MARKETING" == "true" ]]; then
  CONFIG_SET_ARNS_JSON="$(jq -cn \
    --arg transactional "$TRANSACTIONAL_SET_ARN" \
    --arg marketing "$MARKETING_SET_ARN" \
    '[$transactional, $marketing]')"
else
  CONFIG_SET_ARNS_JSON="$(jq -cn --arg transactional "$TRANSACTIONAL_SET_ARN" '[$transactional]')"
fi
SEND_RESOURCE_ARNS_JSON="$(jq -cn \
  --arg email "$IDENTITY_EMAIL_ARN" \
  --arg domain "$IDENTITY_DOMAIN_ARN" \
  --argjson sets "$CONFIG_SET_ARNS_JSON" \
  '[$email, $domain] + $sets')"

jq -n \
  --arg from "$SES_FROM_EMAIL" \
  --arg email "$IDENTITY_EMAIL_ARN" \
  --arg domain "$IDENTITY_DOMAIN_ARN" \
  --arg topic "$SNS_TOPIC_ARN" \
  --argjson sets "$CONFIG_SET_ARNS_JSON" \
  --argjson sendResources "$SEND_RESOURCE_ARNS_JSON" '
  {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadSesAccount",
        Effect: "Allow",
        Action: "ses:GetAccount",
        Resource: "*"
      },
      {
        Sid: "ReadSesIdentities",
        Effect: "Allow",
        Action: "ses:GetEmailIdentity",
        Resource: [$email, $domain]
      },
      {
        Sid: "ReadSesConfigurationSets",
        Effect: "Allow",
        Action: ["ses:GetConfigurationSet", "ses:GetConfigurationSetEventDestinations"],
        Resource: $sets
      },
      {
        Sid: "SendOnlyFromNusend",
        Effect: "Allow",
        Action: "ses:SendEmail",
        Resource: $sendResources,
        Condition: {StringEquals: {"ses:FromAddress": $from}}
      },
      {
        Sid: "ReadFeedbackTopic",
        Effect: "Allow",
        Action: ["sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic"],
        Resource: $topic
      }
    ]
  }
' >"$WORK_DIR/runtime-policy.json"
jq empty "$WORK_DIR/runtime-policy.json"

info "Create or reuse the dedicated runtime IAM user"
if aws iam get-user \
  --user-name "$RUNTIME_IAM_USER_NAME" \
  >"$WORK_DIR/runtime-user.json" \
  2>"$WORK_DIR/get-runtime-user.err"; then
  printf 'Reusing IAM user: %s\n' "$RUNTIME_IAM_USER_NAME"
elif grep -q 'NoSuchEntity' "$WORK_DIR/get-runtime-user.err"; then
  aws iam create-user \
    --user-name "$RUNTIME_IAM_USER_NAME" \
    --tags \
      Key=nusend:managed-by,Value=aws-cli-runbook \
      Key=nusend:environment,Value=production \
    >"$WORK_DIR/runtime-user.json"
  sleep 5
  printf 'Created IAM user: %s\n' "$RUNTIME_IAM_USER_NAME"
else
  cat "$WORK_DIR/get-runtime-user.err" >&2
  fail "Could not inspect the runtime IAM user."
fi

PROPOSED_RUNTIME_POLICY="$(jq -S -c . "$WORK_DIR/runtime-policy.json")"
CURRENT_RUNTIME_POLICY=""
if aws iam get-user-policy \
  --user-name "$RUNTIME_IAM_USER_NAME" \
  --policy-name "$RUNTIME_IAM_POLICY_NAME" \
  >"$WORK_DIR/current-runtime-policy.json" \
  2>"$WORK_DIR/get-runtime-policy.err"; then
  CURRENT_RUNTIME_POLICY="$(jq -S -c '.PolicyDocument' "$WORK_DIR/current-runtime-policy.json")"
elif ! grep -q 'NoSuchEntity' "$WORK_DIR/get-runtime-policy.err"; then
  cat "$WORK_DIR/get-runtime-policy.err" >&2
  fail "Could not inspect the runtime inline policy."
fi

if [[ "$CURRENT_RUNTIME_POLICY" == "$PROPOSED_RUNTIME_POLICY" ]]; then
  printf 'Runtime inline policy already matches.\n'
else
  printf 'Proposed runtime policy:\n'
  jq . "$WORK_DIR/runtime-policy.json"
  confirm_phrase APPLY-IAM-POLICY "This replaces the dedicated runtime inline policy."
  aws iam put-user-policy \
    --user-name "$RUNTIME_IAM_USER_NAME" \
    --policy-name "$RUNTIME_IAM_POLICY_NAME" \
    --policy-document "file://$WORK_DIR/runtime-policy.json"
fi

info "Inspect runtime access keys"
ACCESS_KEYS_JSON="$(aws iam list-access-keys \
  --user-name "$RUNTIME_IAM_USER_NAME" \
  --output json)"
TOTAL_ACCESS_KEY_COUNT="$(jq '[.AccessKeyMetadata[]?] | length' <<<"$ACCESS_KEYS_JSON")"
ACTIVE_ACCESS_KEY_COUNT="$(jq '[.AccessKeyMetadata[]? | select(.Status == "Active")] | length' <<<"$ACCESS_KEYS_JSON")"
jq '.AccessKeyMetadata' <<<"$ACCESS_KEYS_JSON"
printf 'Runtime access keys: %s total, %s active\n' "$TOTAL_ACCESS_KEY_COUNT" "$ACTIVE_ACCESS_KEY_COUNT"

if [[ "$TOTAL_ACCESS_KEY_COUNT" -eq 0 ]]; then
  confirm_phrase CREATE-RUNTIME-KEY "This creates one long-lived production credential."
  mkdir -p "$HOME/.config/nusend"
  chmod 700 "$HOME/.config/nusend"
  umask 077
  RUNTIME_KEY_FILE="$HOME/.config/nusend/runtime-access-key.json"
  [[ ! -e "$RUNTIME_KEY_FILE" ]] || fail "Refusing to overwrite existing secret file: $RUNTIME_KEY_FILE"
  aws iam create-access-key \
    --user-name "$RUNTIME_IAM_USER_NAME" \
    >"$RUNTIME_KEY_FILE"
  chmod 600 "$RUNTIME_KEY_FILE"
  printf 'Created one runtime key in %s (mode 0600).\n' "$RUNTIME_KEY_FILE"
  printf 'Move it directly into the deployment secret store, verify deployment, then securely delete this file.\n'
else
  printf 'No key created. AWS never reveals an existing secret access key again.\n'
fi

info "Non-secret Nusend deployment values"
cat <<EOF
AWS_REGION=$AWS_REGION
NUSEND_SES_FROM_EMAIL=$SES_FROM_EMAIL
NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET=$SES_TRANSACTIONAL_SET
NUSEND_SES_FEEDBACK_TOPIC_ARNS=$SNS_TOPIC_ARN
EOF
if [[ "$ENABLE_MARKETING" == "true" ]]; then
  printf 'NUSEND_SES_MARKETING_CONFIGURATION_SET=%s\n' "$SES_MARKETING_SET"
fi
if [[ "$TRACKING_EVENTS_JSON" != "[]" ]]; then
  TRACKING_EVENTS_CSV="$(jq -r 'map(ascii_downcase) | join(",")' <<<"$TRACKING_EVENTS_JSON")"
  printf 'NUSEND_SES_TRACKING_EVENTS=%s\n' "$TRACKING_EVENTS_CSV"
fi
}

COMMAND="${1:-}"
case "$COMMAND" in
  --help|-h) usage; exit 0 ;;
  preflight|ses|feedback|iam) ;;
  "") usage >&2; exit 2 ;;
  *) fail "Unknown command: $COMMAND" ;;
esac
shift
[[ $# -eq 0 ]] || fail "Unexpected argument: $1"

case "$COMMAND" in
  preflight) run_preflight ;;
  ses) run_ses ;;
  feedback) run_feedback ;;
  iam) run_iam ;;
esac
