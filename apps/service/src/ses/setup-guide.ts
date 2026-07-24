import type { ReadinessCheck, ReadinessStatus, SesReadinessResult } from "../aws/readiness.ts";
import { sesDocs, sesSnsWebhookPath } from "./constants.ts";

export type SetupGuideAction =
  | { readonly kind: "api"; readonly text: string; readonly url: string }
  | { readonly command: string; readonly kind: "cli" }
  | { readonly kind: "console"; readonly text: string };

export type SetupGuideStep = {
  readonly actions: readonly SetupGuideAction[];
  readonly id: string;
  readonly relatedChecks: readonly string[];
  readonly status: ReadinessStatus;
  readonly title: string;
  readonly why: string;
};

export type SesSetupGuide = {
  readonly docs: readonly string[];
  readonly status: ReadinessStatus;
  readonly steps: readonly SetupGuideStep[];
  readonly title: string;
};

export function buildSesSetupGuide(readiness: SesReadinessResult): SesSetupGuide {
  return {
    docs: [sesDocs.setup, sesDocs.readiness, sesDocs.simulator, sesDocs.productionReadiness],
    status: readiness.status,
    steps: [
      step(readiness, {
        actions: [
          { kind: "console", text: "Choose the SES region where you will send mail." },
          { command: "export AWS_REGION=us-east-1", kind: "cli" },
        ],
        id: "choose-region",
        relatedChecks: ["config.aws_region", "aws.credentials_and_account"],
        title: "Choose and configure an SES region",
        why: "SES sandbox, production access, identities, and configuration sets are regional.",
      }),
      step(readiness, {
        actions: [
          { command: "export NUSEND_SES_FROM_EMAIL=sender@example.com", kind: "cli" },
          { command: "export NUSEND_PUBLIC_BASE_URL=https://mail.example.com", kind: "cli" },
        ],
        id: "configure-env",
        relatedChecks: ["config.from_email", "config.public_base_url", "config.worker_budget"],
        title: "Configure Nusend SES environment variables",
        why: "Readiness and generated webhook URLs depend on clean local configuration.",
      }),
      step(readiness, {
        actions: [
          { command: "pnpm nusend:setup aws plan", kind: "cli" },
          { command: "pnpm nusend:setup aws apply", kind: "cli" },
          {
            kind: "console",
            text: "Review the core CloudFormation change set that creates the SES identity; do not create or adopt an identity manually.",
          },
        ],
        id: "verify-sender-identity",
        relatedChecks: ["config.from_email", "ses.identity.from_email"],
        title: "Verify your SES sending identity",
        why: "SES only sends from verified identities.",
      }),
      step(readiness, {
        actions: [
          {
            kind: "console",
            text: "Use the Easy DKIM records output by the coordinator-managed CloudFormation identity. Publish those CNAMEs externally only when Route 53 is not selected; do not recreate the identity.",
          },
        ],
        id: "configure-dkim",
        relatedChecks: ["ses.identity.dkim"],
        title: "Configure DKIM",
        why: "DKIM alignment is required for reliable production inboxing and unsubscribe-header verification.",
      }),
      step(readiness, {
        actions: [
          {
            kind: "console",
            text: "Request SES production access if you need non-simulator recipients.",
          },
        ],
        id: "production-access",
        relatedChecks: ["ses.account.production_access", "ses.account.sending_enabled"],
        title: "Enable production sending when needed",
        why: "Sandbox accounts can only send to verified recipients or simulator addresses.",
      }),
      step(readiness, {
        actions: [
          { command: "pnpm nusend:setup aws plan", kind: "cli" },
          { command: "pnpm nusend:setup aws apply", kind: "cli" },
          {
            kind: "console",
            text: "Create configuration sets only through the reviewed core CloudFormation change set; never create same-name SES resources manually.",
          },
        ],
        id: "configuration-sets",
        relatedChecks: [
          "config.configuration_set.transactional",
          "config.configuration_set.marketing",
          "ses.config_set.transactional.exists",
          "ses.config_set.marketing.exists",
        ],
        title: "Create SES configuration sets",
        why: "Configuration sets attach event publishing and tracking behavior to each send.",
      }),
      step(readiness, {
        actions: [
          {
            kind: "console",
            text: "Confirm the coordinator-managed CloudFormation configuration sets have SuppressionOptions.SuppressedReasons set to BOUNCE and COMPLAINT; change them through a reviewed stack update, not manually.",
          },
        ],
        id: "configuration-set-suppression",
        relatedChecks: [
          "ses.config_set.transactional.suppression",
          "ses.config_set.marketing.suppression",
        ],
        title: "Confirm configuration-set suppression",
        why: "Nusend keeps local suppressions as source of truth, while SES configuration-set suppression adds stack-owned reputation protection for every send.",
      }),
      step(readiness, {
        actions: [
          { command: "pnpm nusend:setup aws plan", kind: "cli" },
          { command: "pnpm nusend:setup aws apply", kind: "cli" },
          {
            kind: "console",
            text: "Use the Standard SNS topic and SES publish policy created by the reviewed core CloudFormation change set; do not create a topic manually.",
          },
        ],
        id: "sns-topic",
        relatedChecks: [
          "config.feedback_topics",
          "sns.topic.exists",
          "sns.topic.signature_version",
        ],
        title: "Create and configure SNS feedback topic",
        why: "SES publishes delivery, bounce, complaint, open, and click events through SNS.",
      }),
      step(readiness, {
        actions: [
          {
            kind: "api",
            text: "Use this exact webhook URL for the SNS HTTPS subscription.",
            url: readiness.expectedWebhookUrl ?? sesSnsWebhookPath,
          },
          { command: "pnpm nusend:setup continue", kind: "cli" },
          {
            kind: "console",
            text: "Let the coordinator's finalize CloudFormation change set create the one HTTPS subscription after healthy deploy. Never manually create a second subscription, including while confirmation is pending.",
          },
        ],
        id: "webhook-subscription",
        relatedChecks: ["config.public_base_url", "sns.subscription.webhook"],
        title: "Subscribe SNS to the Nusend webhook",
        why: "Nusend must receive signed SNS messages to store SES events and suppress bounces/complaints.",
      }),
      step(readiness, {
        actions: [
          {
            kind: "console",
            text: "Use the event destinations attached by the reviewed core CloudFormation change set. Update them only through pnpm nusend:setup AWS plan/apply, never manually.",
          },
        ],
        id: "event-destinations",
        relatedChecks: ["ses.config_set.transactional.events", "ses.config_set.marketing.events"],
        title: "Enable SES event publishing",
        why: "No feedback or tracking is emitted unless sends use a configuration set with event destinations.",
      }),
      step(readiness, {
        actions: [
          {
            kind: "console",
            text: "Use the SQS DLQ, redrive policy, alarm topic, and CloudWatch alarms created by the reviewed CloudFormation stack; do not attach or create replacements manually.",
          },
        ],
        id: "sns-dlq-alarms",
        relatedChecks: ["sns.subscription.webhook"],
        title: "Configure SNS DLQ and alarms",
        why: "SNS HTTPS delivery failures should be visible and recoverable during production operations.",
      }),
      step(readiness, {
        actions: [
          {
            kind: "console",
            text: "Select OPEN/CLICK tracking during pnpm nusend:setup init, then let the reviewed CloudFormation change set manage the marketing event destination.",
          },
          { command: "pnpm nusend:setup aws plan", kind: "cli" },
        ],
        id: "engagement-tracking",
        relatedChecks: ["config.tracking", "ses.config_set.marketing.tracking_domain"],
        title: "Configure optional engagement tracking",
        why: "Open/click tracking requires SES event publishing and optionally a branded custom redirect domain.",
      }),
      step(readiness, {
        actions: [{ command: "export NUSEND_UNSUBSCRIBE_SECRET=<32+ random chars>", kind: "cli" }],
        id: "marketing-unsubscribe",
        relatedChecks: ["config.unsubscribe_secret", "config.public_base_url"],
        title: "Configure marketing unsubscribe support",
        why: "Marketing sends require signed public unsubscribe URLs and one-click unsubscribe headers.",
      }),
      step(readiness, {
        actions: [
          {
            kind: "api",
            text: "Run readiness without AWS calls while configuring locally.",
            url: "/api/operations/ses/readiness?includeAws=false",
          },
          {
            kind: "api",
            text: "Run full readiness once AWS credentials and resources are available.",
            url: "/api/operations/ses/readiness",
          },
        ],
        id: "run-readiness",
        relatedChecks: ["db.ses_operations_schema", "aws.credentials_and_account"],
        title: "Run SES readiness checks",
        why: "Readiness explains missing config, AWS resource gaps, and next actions in one JSON response.",
      }),
      step(readiness, {
        actions: [
          {
            command:
              "docker compose exec -T api bun apps/service/src/ses/simulator-main.ts success --purpose transactional --mode send-acceptance",
            kind: "cli",
          },
          {
            command:
              "docker compose exec -T api bun apps/service/src/ses/simulator-main.ts bounce --purpose transactional --mode end-to-end",
            kind: "cli",
          },
        ],
        id: "simulator-validation",
        relatedChecks: ["operations.latest_feedback"],
        title: "Validate with the SES mailbox simulator",
        why: "Simulator scenarios prove sends, webhooks, suppressions, and operations visibility without reputation impact.",
      }),
      step(readiness, {
        actions: [
          {
            kind: "console",
            text: "Before real marketing volume, inspect Gmail Show Original for DKIM and List-Unsubscribe headers.",
          },
        ],
        id: "manual-production-checks",
        relatedChecks: ["ses.identity.dkim", "operations.latest_feedback"],
        title: "Perform final manual production checks",
        why: "Inbox providers and one-click unsubscribe behavior need a real recipient/client sanity check before marketing volume.",
      }),
    ],
    title: "Set up AWS SES for Nusend",
  };
}

function step(
  readiness: SesReadinessResult,
  input: Omit<SetupGuideStep, "status">,
): SetupGuideStep {
  // filter (not find): a related check id can appear once per feedback topic, and
  // a failure on ANY topic must be reflected — find() would silently take only the
  // first (often passing) one.
  const related = input.relatedChecks.flatMap((id) =>
    readiness.checks.filter((check) => check.id === id),
  );
  return { ...input, status: related.length === 0 ? "warning" : aggregate(related) };
}

function aggregate(checks: readonly ReadinessCheck[]): ReadinessStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning" || check.status === "skipped"))
    return "warning";
  return "ok";
}
