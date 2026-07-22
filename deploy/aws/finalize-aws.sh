#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/aws/lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
Usage: deploy/aws/finalize-aws.sh <command>

Commands:
  subscribe  Subscribe the deployed HTTPS webhook and attach its DLQ
  alarms     Provision the operator topic and CloudWatch alarms
  validate   Perform read-only validation of the completed AWS setup

Run only after Nusend is publicly healthy with the feedback topic configured.
Run commands individually in this order; no automatic all mode is provided.
EOF
}

run_subscribe() {
load_setup
load_dlq
SES_WEBHOOK_URL="https://${NUSEND_DOMAIN}/api/webhooks/aws/sns/ses"

info "Verify the deployed public endpoint"
print_context
curl -fsS "https://${NUSEND_DOMAIN}/health" >/dev/null
printf 'Public webhook: %s\n' "$SES_WEBHOOK_URL"
printf 'The deployment must already use NUSEND_SES_FEEDBACK_TOPIC_ARNS=%s\n' "$SNS_TOPIC_ARN"
confirm_phrase SUBSCRIBE-WEBHOOK "Confirm the running deployment uses this exact topic ARN and public URL."

info "Create or reuse the exact HTTPS subscription"
SUBSCRIPTIONS_JSON="$(aws sns list-subscriptions-by-topic \
  --topic-arn "$SNS_TOPIC_ARN" \
  --output json)"
MATCHING_SUBSCRIPTIONS="$(jq -c --arg endpoint "$SES_WEBHOOK_URL" '
  [.Subscriptions[]? | select(.Protocol == "https" and .Endpoint == $endpoint)]
' <<<"$SUBSCRIPTIONS_JSON")"
MATCHING_SUBSCRIPTION_COUNT="$(jq 'length' <<<"$MATCHING_SUBSCRIPTIONS")"

if [[ "$MATCHING_SUBSCRIPTION_COUNT" -gt 1 ]]; then
  jq . <<<"$MATCHING_SUBSCRIPTIONS" >&2
  fail "Multiple matching subscriptions exist. Resolve duplicates manually."
elif [[ "$MATCHING_SUBSCRIPTION_COUNT" -eq 0 ]]; then
  aws sns subscribe \
    --topic-arn "$SNS_TOPIC_ARN" \
    --protocol https \
    --notification-endpoint "$SES_WEBHOOK_URL" \
    --return-subscription-arn \
    --output json
else
  printf 'Reusing existing matching subscription:\n'
  jq . <<<"$MATCHING_SUBSCRIPTIONS"
fi

info "Wait for Nusend's automatic signed confirmation"
SNS_SUBSCRIPTION_ARN=""
for attempt in $(seq 1 24); do
  SUBSCRIPTIONS_JSON="$(aws sns list-subscriptions-by-topic \
    --topic-arn "$SNS_TOPIC_ARN" \
    --output json)"
  SNS_SUBSCRIPTION_ARN="$(jq -r --arg endpoint "$SES_WEBHOOK_URL" '
    [.Subscriptions[]? |
     select(
       .Protocol == "https" and
       .Endpoint == $endpoint and
       .SubscriptionArn != "PendingConfirmation" and
       .SubscriptionArn != "pending confirmation"
     )][0].SubscriptionArn // empty
  ' <<<"$SUBSCRIPTIONS_JSON")"
  [[ -n "$SNS_SUBSCRIPTION_ARN" ]] && break
  printf 'Waiting for confirmation (%s/24)...\n' "$attempt"
  sleep 5
done

if [[ -z "$SNS_SUBSCRIPTION_ARN" ]]; then
  printf 'The exact subscription remains pending; do not create another duplicate.\n' >&2
  printf 'Inspect API/Caddy logs, the topic allowlist, public TLS, and outbound HTTPS access.\n' >&2
  exit 1
fi
printf 'Confirmed subscription ARN: %s\n' "$SNS_SUBSCRIPTION_ARN"

info "Enforce the SNS envelope and attach the DLQ"
REDRIVE_POLICY="$(jq -cn --arg arn "$SNS_DLQ_ARN" '{deadLetterTargetArn:$arn}')"
aws sns set-subscription-attributes \
  --subscription-arn "$SNS_SUBSCRIPTION_ARN" \
  --attribute-name RawMessageDelivery \
  --attribute-value false
aws sns set-subscription-attributes \
  --subscription-arn "$SNS_SUBSCRIPTION_ARN" \
  --attribute-name RedrivePolicy \
  --attribute-value "$REDRIVE_POLICY"

ATTRIBUTES_JSON="$(aws sns get-subscription-attributes \
  --subscription-arn "$SNS_SUBSCRIPTION_ARN" \
  --output json)"
jq '.Attributes | {
  Endpoint,
  Protocol,
  PendingConfirmation,
  RawMessageDelivery,
  RedrivePolicy
}' <<<"$ATTRIBUTES_JSON"

jq -e --arg endpoint "$SES_WEBHOOK_URL" --arg dlq "$SNS_DLQ_ARN" '
  .Attributes.Endpoint == $endpoint and
  .Attributes.Protocol == "https" and
  .Attributes.PendingConfirmation == "false" and
  .Attributes.RawMessageDelivery == "false" and
  ((.Attributes.RedrivePolicy | fromjson).deadLetterTargetArn == $dlq)
' <<<"$ATTRIBUTES_JSON" >/dev/null || fail "Subscription attributes do not match the expected endpoint/envelope/DLQ."

printf '\nWebhook subscription is confirmed and its DLQ is attached.\n'
}

run_alarms() {
load_setup
info "Provisioning context"
print_context

if [[ -z "$ALARM_ACTION_ARN" ]]; then
  info "Create or reuse the operator-notification topic"
  ALARM_ACTION_ARN="$(aws sns create-topic \
    --name "$ALARM_TOPIC_NAME" \
    --tags \
      Key=nusend:managed-by,Value=aws-cli-runbook \
      Key=nusend:environment,Value=production \
    --query 'TopicArn' \
    --output text)"

  ALARM_SUBSCRIPTIONS_JSON="$(aws sns list-subscriptions-by-topic \
    --topic-arn "$ALARM_ACTION_ARN" \
    --output json)"
  ALARM_EMAIL_MATCHES="$(jq -c --arg email "$OPS_ALERT_EMAIL" '
    [.Subscriptions[]? | select(.Protocol == "email" and .Endpoint == $email)]
  ' <<<"$ALARM_SUBSCRIPTIONS_JSON")"
  ALARM_EMAIL_MATCH_COUNT="$(jq 'length' <<<"$ALARM_EMAIL_MATCHES")"

  if [[ "$ALARM_EMAIL_MATCH_COUNT" -gt 1 ]]; then
    jq . <<<"$ALARM_EMAIL_MATCHES" >&2
    fail "Multiple matching alarm email subscriptions exist. Resolve duplicates manually."
  elif [[ "$ALARM_EMAIL_MATCH_COUNT" -eq 0 ]]; then
    aws sns subscribe \
      --topic-arn "$ALARM_ACTION_ARN" \
      --protocol email \
      --notification-endpoint "$OPS_ALERT_EMAIL"
  fi

  ALARM_SUBSCRIPTIONS_JSON="$(aws sns list-subscriptions-by-topic \
    --topic-arn "$ALARM_ACTION_ARN" \
    --output json)"
  CONFIRMED_ALARM_EMAIL_ARN="$(jq -r --arg email "$OPS_ALERT_EMAIL" '
    [.Subscriptions[]? |
     select(
       .Protocol == "email" and
       .Endpoint == $email and
       .SubscriptionArn != "PendingConfirmation" and
       .SubscriptionArn != "pending confirmation"
     )][0].SubscriptionArn // empty
  ' <<<"$ALARM_SUBSCRIPTIONS_JSON")"

  if [[ -z "$CONFIRMED_ALARM_EMAIL_ARN" ]]; then
    printf 'AWS sent a confirmation message to %s. Approve it, then rerun this script.\n' "$OPS_ALERT_EMAIL" >&2
    exit 1
  fi
fi

[[ "$ALARM_ACTION_ARN" != "$SNS_TOPIC_ARN" ]] || fail "Refusing to use the SES feedback topic for alarm notifications."
EXPECTED_ALARM_PREFIX="arn:${AWS_PARTITION}:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:"
[[ "$ALARM_ACTION_ARN" == "$EXPECTED_ALARM_PREFIX"* ]] || fail "ALARM_ACTION_ARN must be a same-account, same-region SNS topic ARN."
aws sns get-topic-attributes --topic-arn "$ALARM_ACTION_ARN" >/dev/null
printf 'CloudWatch alarm action: %s\n' "$ALARM_ACTION_ARN"

info "Create or update CloudWatch alarms"
ALARM_ACTION_ARGUMENTS=(--alarm-actions "$ALARM_ACTION_ARN")
put_sns_alarm() {
  local metric="$1"
  local suffix="$2"
  aws cloudwatch put-metric-alarm \
    --alarm-name "${ALARM_NAME_PREFIX}-${suffix}" \
    --alarm-description "Nusend SNS ${metric} is greater than zero" \
    --namespace AWS/SNS \
    --metric-name "$metric" \
    --dimensions Name=TopicName,Value="$SNS_TOPIC_NAME" \
    --statistic Sum \
    --period 300 \
    --evaluation-periods 1 \
    --datapoints-to-alarm 1 \
    --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    "${ALARM_ACTION_ARGUMENTS[@]}"
}

put_sns_alarm NumberOfNotificationsFailed sns-notifications-failed
put_sns_alarm NumberOfNotificationsRedrivenToDlq sns-redriven-to-dlq
put_sns_alarm NumberOfNotificationsFailedToRedriveToDlq sns-redrive-failed

aws cloudwatch put-metric-alarm \
  --alarm-name "${ALARM_NAME_PREFIX}-dlq-visible-messages" \
  --alarm-description "Nusend SNS webhook DLQ contains visible messages" \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value="$SNS_DLQ_NAME" \
  --statistic Maximum \
  --period 300 \
  --evaluation-periods 1 \
  --datapoints-to-alarm 1 \
  --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  "${ALARM_ACTION_ARGUMENTS[@]}"

ALARMS_JSON="$(aws cloudwatch describe-alarms \
  --alarm-name-prefix "$ALARM_NAME_PREFIX" \
  --output json)"
jq '[.MetricAlarms[] | {Name: .AlarmName, State: .StateValue, Actions: .AlarmActions, Metric: .MetricName}]' <<<"$ALARMS_JSON"
EXPECTED_ALARMS_JSON="$(jq -cn --arg prefix "$ALARM_NAME_PREFIX" '[
  {name: ($prefix + "-sns-notifications-failed"), metric: "NumberOfNotificationsFailed"},
  {name: ($prefix + "-sns-redriven-to-dlq"), metric: "NumberOfNotificationsRedrivenToDlq"},
  {name: ($prefix + "-sns-redrive-failed"), metric: "NumberOfNotificationsFailedToRedriveToDlq"},
  {name: ($prefix + "-dlq-visible-messages"), metric: "ApproximateNumberOfMessagesVisible"}
]')"
jq -e --arg action "$ALARM_ACTION_ARN" --argjson expected "$EXPECTED_ALARMS_JSON" '
  .MetricAlarms as $alarms |
  all($expected[];
    . as $wanted |
    any($alarms[];
      .AlarmName == $wanted.name and
      .MetricName == $wanted.metric and
      (.AlarmActions | index($action)) != null
    )
  )
' <<<"$ALARMS_JSON" >/dev/null || fail "One or more expected alarms, metrics, or notification actions do not match."

printf '\nAlarms are configured. Exercise the notification path according to the incident procedure.\n'
}

run_validate() {
load_setup
load_dlq
SES_WEBHOOK_URL="https://${NUSEND_DOMAIN}/api/webhooks/aws/sns/ses"

info "Provisioning context"
print_context

info "Validate SES account and identity"
ACCOUNT_JSON="$(aws sesv2 get-account --output json)"
jq '{
  ProductionAccessEnabled,
  ReviewStatus: .Details.ReviewDetails.Status,
  SendingEnabled,
  EnforcementStatus,
  SendQuota,
  SuppressedReasons: .SuppressionAttributes.SuppressedReasons
}' <<<"$ACCOUNT_JSON"
IDENTITY_JSON="$(aws sesv2 get-email-identity \
  --email-identity "$SES_IDENTITY" \
  --output json)"
jq '{
  VerificationStatus,
  VerifiedForSendingStatus,
  DkimStatus: .DkimAttributes.Status,
  DkimSigningEnabled: .DkimAttributes.SigningEnabled
}' <<<"$IDENTITY_JSON"

jq -e '
  .ProductionAccessEnabled == true and
  .SendingEnabled == true and
  ((.SuppressionAttributes.SuppressedReasons // []) | index("BOUNCE") != null) and
  ((.SuppressionAttributes.SuppressedReasons // []) | index("COMPLAINT") != null)
' <<<"$ACCOUNT_JSON" >/dev/null || fail "SES production access, sending, or account suppression is not ready."
jq -e '
  .VerificationStatus == "SUCCESS" and
  .VerifiedForSendingStatus == true and
  .DkimAttributes.SigningEnabled == true and
  .DkimAttributes.Status == "SUCCESS"
' <<<"$IDENTITY_JSON" >/dev/null || fail "SES identity verification or DKIM is not ready."

info "Inspect SES event destinations"
aws sesv2 get-configuration-set-event-destinations \
  --configuration-set-name "$SES_TRANSACTIONAL_SET" \
  --output json | jq .
if [[ "$ENABLE_MARKETING" == "true" ]]; then
  aws sesv2 get-configuration-set-event-destinations \
    --configuration-set-name "$SES_MARKETING_SET" \
    --output json | jq .
fi

info "Validate the restricted SNS topic and exact confirmed webhook subscription"
TOPIC_ATTRIBUTES_JSON="$(aws sns get-topic-attributes \
  --topic-arn "$SNS_TOPIC_ARN" \
  --output json)"
[[ "$(jq -r '.Attributes.SignatureVersion' <<<"$TOPIC_ATTRIBUTES_JSON")" == "2" ]] || fail "SNS SignatureVersion must be 2."
if [[ "$ENABLE_MARKETING" == "true" ]]; then
  EXPECTED_SOURCE_ARNS_JSON="$(jq -cn \
    --arg transactional "$TRANSACTIONAL_SET_ARN" \
    --arg marketing "$MARKETING_SET_ARN" \
    '[$transactional, $marketing]')"
else
  EXPECTED_SOURCE_ARNS_JSON="$(jq -cn --arg transactional "$TRANSACTIONAL_SET_ARN" '[$transactional]')"
fi
jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg topic "$SNS_TOPIC_ARN" \
  --argjson sources "$EXPECTED_SOURCE_ARNS_JSON" '
  (.Attributes.Policy | fromjson) as $policy |
  any($policy.Statement[]?;
    .Effect == "Allow" and
    .Principal.Service == "ses.amazonaws.com" and
    .Action == "sns:Publish" and
    .Resource == $topic and
    .Condition.StringEquals["aws:SourceAccount"] == $account and
    ((.Condition.ArnEquals["aws:SourceArn"] | if type == "array" then . else [.] end | sort) == ($sources | sort))
  )
' <<<"$TOPIC_ATTRIBUTES_JSON" >/dev/null || fail "SNS topic policy does not match the restricted SES configuration-set policy."

SUBSCRIPTIONS_JSON="$(aws sns list-subscriptions-by-topic \
  --topic-arn "$SNS_TOPIC_ARN" \
  --output json)"
CONFIRMED_MATCHES="$(jq -c --arg endpoint "$SES_WEBHOOK_URL" '
  [.Subscriptions[]? |
   select(
     .Protocol == "https" and
     .Endpoint == $endpoint and
     .SubscriptionArn != "PendingConfirmation" and
     .SubscriptionArn != "pending confirmation"
   )]
' <<<"$SUBSCRIPTIONS_JSON")"
[[ "$(jq 'length' <<<"$CONFIRMED_MATCHES")" -eq 1 ]] || fail "Expected exactly one confirmed subscription for $SES_WEBHOOK_URL."
SNS_SUBSCRIPTION_ARN="$(jq -r '.[0].SubscriptionArn' <<<"$CONFIRMED_MATCHES")"
SUBSCRIPTION_ATTRIBUTES_JSON="$(aws sns get-subscription-attributes \
  --subscription-arn "$SNS_SUBSCRIPTION_ARN" \
  --output json)"
jq '.Attributes | {Endpoint, Protocol, PendingConfirmation, RawMessageDelivery, RedrivePolicy}' <<<"$SUBSCRIPTION_ATTRIBUTES_JSON"
jq -e --arg endpoint "$SES_WEBHOOK_URL" --arg dlq "$SNS_DLQ_ARN" '
  .Attributes.Endpoint == $endpoint and
  .Attributes.Protocol == "https" and
  .Attributes.PendingConfirmation == "false" and
  .Attributes.RawMessageDelivery == "false" and
  ((.Attributes.RedrivePolicy | fromjson).deadLetterTargetArn == $dlq)
' <<<"$SUBSCRIPTION_ATTRIBUTES_JSON" >/dev/null || fail "Webhook subscription attributes are not ready."

info "Validate the encrypted, empty, restricted DLQ"
DLQ_ATTRIBUTES_JSON="$(aws sqs get-queue-attributes \
  --queue-url "$SNS_DLQ_URL" \
  --attribute-names QueueArn ApproximateNumberOfMessages MessageRetentionPeriod SqsManagedSseEnabled Policy \
  --output json)"
jq '.Attributes | {QueueArn, ApproximateNumberOfMessages, MessageRetentionPeriod, SqsManagedSseEnabled}' <<<"$DLQ_ATTRIBUTES_JSON"
jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg queue "$SNS_DLQ_ARN" \
  --arg topic "$SNS_TOPIC_ARN" '
  .Attributes.QueueArn == $queue and
  .Attributes.MessageRetentionPeriod == "1209600" and
  .Attributes.SqsManagedSseEnabled == "true" and
  .Attributes.ApproximateNumberOfMessages == "0" and
  ((.Attributes.Policy | fromjson) as $policy |
    any($policy.Statement[]?;
      .Effect == "Allow" and
      .Principal.Service == "sns.amazonaws.com" and
      .Action == "sqs:SendMessage" and
      .Resource == $queue and
      .Condition.StringEquals["aws:SourceAccount"] == $account and
      .Condition.ArnEquals["aws:SourceArn"] == $topic
    ))
' <<<"$DLQ_ATTRIBUTES_JSON" >/dev/null || fail "DLQ retention, encryption, policy, or empty-queue gate is not ready."

info "Validate CloudWatch alarms"
ALARMS_JSON="$(aws cloudwatch describe-alarms \
  --alarm-name-prefix "$ALARM_NAME_PREFIX" \
  --output json)"
jq '[.MetricAlarms[] | {Name: .AlarmName, State: .StateValue, Actions: .AlarmActions, Metric: .MetricName}]' <<<"$ALARMS_JSON"
EXPECTED_ALARMS_JSON="$(jq -cn --arg prefix "$ALARM_NAME_PREFIX" '[
  {name: ($prefix + "-sns-notifications-failed"), metric: "NumberOfNotificationsFailed"},
  {name: ($prefix + "-sns-redriven-to-dlq"), metric: "NumberOfNotificationsRedrivenToDlq"},
  {name: ($prefix + "-sns-redrive-failed"), metric: "NumberOfNotificationsFailedToRedriveToDlq"},
  {name: ($prefix + "-dlq-visible-messages"), metric: "ApproximateNumberOfMessagesVisible"}
]')"
jq -e --argjson expected "$EXPECTED_ALARMS_JSON" '
  .MetricAlarms as $alarms |
  all($expected[];
    . as $wanted |
    any($alarms[];
      .AlarmName == $wanted.name and
      .MetricName == $wanted.metric and
      (.AlarmActions | length) > 0
    )
  )
' <<<"$ALARMS_JSON" >/dev/null || fail "One or more expected alarms, metrics, or notification actions do not match."

printf '\nAWS-side validation passed. Nusend readiness and live feedback require 'validate-nusend.sh' and 'run-simulator.sh'.\n'
}

COMMAND="${1:-}"
case "$COMMAND" in
  --help|-h) usage; exit 0 ;;
  subscribe|alarms|validate) ;;
  "") usage >&2; exit 2 ;;
  *) fail "Unknown command: $COMMAND" ;;
esac
shift
[[ $# -eq 0 ]] || fail "Unexpected argument: $1"

case "$COMMAND" in
  subscribe) run_subscribe ;;
  alarms) run_alarms ;;
  validate) run_validate ;;
esac
