import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AWS_PLAN_KEY = "aws";
export const STACK_NAME_PREFIX = "nusend-";
export const CHANGE_SET_NAME_PREFIX = "nusend-";
export const APPLY_PHRASE_PREFIX = "APPLY";
export const REQUEST_PRODUCTION_ACCESS_PHRASE = "REQUEST-PRODUCTION-ACCESS";
export const CREATE_RUNTIME_KEY_PHRASE = "CREATE-RUNTIME-KEY";
export const REQUIRED_CAPABILITY = "CAPABILITY_NAMED_IAM";
/** Durable apply checkpoint: provider succeeded; local env/state finalization may still be pending. */
export const APPLY_CHECKPOINT_LOCAL_FINALIZATION = "local-finalization";

export const WEBHOOK_PATH = "/api/webhooks/aws/sns/ses";

/** Bounded SNS confirmation polling (matches legacy validate.mjs). */
export const SUBSCRIPTION_POLL_ATTEMPTS = 12;
export const SUBSCRIPTION_POLL_INTERVAL = "5 seconds" as const;

/** Known non-secret stack outputs mapped into deployment.env. */
export const STACK_OUTPUT_ENV_MAP = Object.freeze({
  AwsRegion: "AWS_REGION",
  SesFromEmail: "NUSEND_SES_FROM_EMAIL",
  TransactionalConfigurationSetName: "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET",
  MarketingConfigurationSetName: "NUSEND_SES_MARKETING_CONFIGURATION_SET",
  FeedbackTopicArn: "NUSEND_SES_FEEDBACK_TOPIC_ARNS",
  TrackingEvents: "NUSEND_SES_TRACKING_EVENTS",
} as const);

/** Honest SES production-access brief fields (non-secret). */
export const PRODUCTION_BRIEF_FIELDS = Object.freeze([
  "website",
  "useCase",
  "mailType",
  "expectedVolume",
  "frequency",
  "recipientConsent",
  "unsubscribe",
  "bounceComplaintHandling",
  "formAbuseControls",
  "monitoring",
  "contactLanguage",
] as const);

export type ProductionBriefField = (typeof PRODUCTION_BRIEF_FIELDS)[number];

export const FABRICATED_PLACEHOLDERS = Object.freeze(
  new Set([
    "n/a",
    "na",
    "none",
    "null",
    "undefined",
    "todo",
    "tbd",
    "test",
    "testing",
    "example",
    "example.com",
    "www.example.com",
    "http://example.com",
    "https://example.com",
    "placeholder",
    "changeme",
    "fill me",
    "fillme",
    "xxx",
    "yyyy",
    "foo",
    "bar",
    "baz",
    "asdf",
    "qwerty",
    "sample",
    "dummy",
    "lorem",
    "lorem ipsum",
    "string",
    "value",
    "unknown",
  ]),
);

export function defaultStackTemplatePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../../../deploy/aws/nusend-stack.json");
}
