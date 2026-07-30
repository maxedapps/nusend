import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_SIMULATOR_PHRASE = "RUN-SES-SIMULATOR";
export const ALARM_EXERCISE_PHRASE_PREFIX = "ALARM-NOTIFICATION-EXERCISED";
export const VALIDATION_PLAN_KEY = "validation";
export const REFRESH_PLAN_KEY = "refresh";
export const WEBHOOK_PATH = "/api/webhooks/aws/sns/ses";

/** apps/setup-cli/src/validate → apps/cli/dist/main.js */
export function defaultCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "cli", "dist", "main.js");
}

export const CLI_PATH = defaultCliPath();

export const BASE_REQUIRED_READINESS_IDS = Object.freeze([
  "config.aws_region",
  "config.from_email",
  "config.configuration_set.transactional",
  "config.feedback_topics",
  "db.ses_operations_schema",
  "aws.credentials_and_account",
  "ses.account.production_access",
  "ses.account.sending_enabled",
  "ses.account.enforcement_status",
  "ses.identity.from_email",
  "ses.identity.dkim",
  "ses.config_set.transactional.exists",
  "ses.config_set.transactional.suppression",
  "ses.config_set.transactional.events",
  "sns.topic.exists",
  "sns.topic.signature_version",
  "sns.subscription.webhook",
]);

export const MARKETING_REQUIRED_READINESS_IDS = Object.freeze([
  "config.configuration_set.marketing",
  "config.unsubscribe_secret",
  "ses.config_set.marketing.exists",
  "ses.config_set.marketing.suppression",
  "ses.config_set.marketing.events",
]);

export type ProductionGateDefinition = {
  readonly id: string;
  readonly title: string;
  readonly phrase: (state: { installationId: string; config: Record<string, unknown> }) => string;
  readonly action: string;
};

export const PRODUCTION_GATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "backup_restore",
    title: "Backup restore proof",
    phrase: (state: { installationId: string }) => `BACKUP-RESTORE-PROVEN ${state.installationId}`,
    action:
      "Restore the latest restic backup into an isolated location and verify the database before confirming.",
  }),
  Object.freeze({
    id: "reboot_recovery",
    title: "VPS reboot recovery proof",
    phrase: (state: { config: { sshTarget: string } }) =>
      `REBOOT-RECOVERY-PROVEN ${state.config.sshTarget}`,
    action:
      "Perform an authorized VPS reboot and verify Compose and mandatory backup health recover before confirming.",
  }),
  Object.freeze({
    id: "gmail_headers",
    title: "Real Gmail DKIM/header inspection",
    phrase: (state: { config: { domain: string } }) =>
      `GMAIL-HEADERS-PROVEN ${state.config.domain}`,
    action:
      "Send an authorized real message to Gmail and inspect Authentication-Results/DKIM headers before confirming.",
  }),
  Object.freeze({
    id: "dmarc",
    title: "DMARC policy evidence",
    phrase: (state: { config: { sesIdentity: string } }) =>
      `DMARC-PROVEN ${state.config.sesIdentity}`,
    action:
      "Publish and verify the operator-selected DMARC policy outside this coordinator before confirming.",
  }),
  Object.freeze({
    id: "quota_ramp",
    title: "SES quota and ramp plan",
    phrase: (state: { config: { awsAccountId: string; awsRegion: string } }) =>
      `QUOTA-RAMP-REVIEWED ${state.config.awsAccountId} ${state.config.awsRegion}`,
    action:
      "Review current SES quotas and document a conservative volume/ramp plan before confirming.",
  }),
  Object.freeze({
    id: "provider_firewall",
    title: "Provider firewall verification",
    phrase: (state: { config: { domain: string } }) =>
      `PROVIDER-FIREWALL-VERIFIED ${state.config.domain}`,
    action:
      "Verify the provider firewall and ingress-mode restrictions from the provider console before confirming.",
  }),
]);

export const EXPECTED_ALARMS = Object.freeze([
  ["sns-notifications-failed", "NumberOfNotificationsFailed"],
  ["sns-redriven-to-dlq", "NumberOfNotificationsRedrivenToDlq"],
  ["sns-redrive-failed", "NumberOfNotificationsFailedToRedriveToDlq"],
  ["dlq-visible-messages", "ApproximateNumberOfMessagesVisible"],
] as const);
