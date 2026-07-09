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
          { kind: "console", text: "Open SES > Identities and verify the From email or domain." },
          {
            command: "aws sesv2 get-email-identity --email-identity sender@example.com",
            kind: "cli",
          },
        ],
        id: "verify-sender-identity",
        relatedChecks: ["config.from_email", "ses.identity.from_email"],
        title: "Verify your SES sending identity",
        why: "SES only sends from verified identities.",
      }),
      step(readiness, {
        actions: [
          { kind: "console", text: "Configure Easy DKIM for the sending domain or identity." },
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
          {
            command:
              "aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT",
            kind: "cli",
          },
        ],
        id: "account-suppression",
        relatedChecks: ["ses.account.suppression_recommendation"],
        title: "Enable account-level suppression defense in depth",
        why: "Nusend keeps local suppressions as source of truth, while SES account suppression adds reputation protection.",
      }),
      step(readiness, {
        actions: [
          { kind: "console", text: "Create transactional and marketing SES configuration sets." },
          {
            command:
              "aws sesv2 create-configuration-set --configuration-set-name nusend-transactional-prod",
            kind: "cli",
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
          { kind: "console", text: "Create a Standard SNS topic and allow SES to publish to it." },
          { command: "aws sns create-topic --name nusend-ses-events-prod", kind: "cli" },
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
          { kind: "console", text: "Subscribe the SNS topic to the Nusend HTTPS webhook." },
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
            text: "Enable required SES event destinations for both configuration sets.",
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
            text: "Attach an SNS subscription DLQ and alarms for failed deliveries.",
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
            text: "Enable OPEN/CLICK event destinations only if engagement tracking is desired.",
          },
          { command: "export NUSEND_SES_TRACKING_EVENTS=open,click", kind: "cli" },
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
              "pnpm --filter @nusend/service ses:simulate success --purpose transactional --mode send-acceptance",
            kind: "cli",
          },
          {
            command:
              "pnpm --filter @nusend/service ses:simulate bounce --purpose transactional --mode end-to-end",
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
  const related = input.relatedChecks
    .map((id) => readiness.checks.find((check) => check.id === id))
    .filter(Boolean) as ReadinessCheck[];
  return { ...input, status: related.length === 0 ? "warning" : aggregate(related) };
}

function aggregate(checks: readonly ReadinessCheck[]): ReadinessStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning" || check.status === "skipped"))
    return "warning";
  return "ok";
}
