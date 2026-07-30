/** Default schema for brand-new installs until migration publishes v2. */
export const STATE_SCHEMA_VERSION = 1 as const;
export const STATE_SCHEMA_VERSION_V2 = 2 as const;
export const SUPPORTED_STATE_SCHEMA_VERSIONS = [1, 2] as const;

export const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/u;
export const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u;
export const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/u;

export const CURRENT_POINTER_NAME = "current";
export const STATE_FILE_NAME = "state.json";
export const ENV_FILE_NAME = "deployment.env";
/** Single non-secret administrator artifact in the installation directory. */
export const PROVISIONER_POLICY_FILE_NAME = "nusend-provisioner-policy.json";

/** Keys that must never appear in state.json, status, plans, or logs. */
export const SECRET_ENV_KEYS = Object.freeze([
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "NUSEND_API_KEY_HASH_SECRET",
  "NUSEND_UNSUBSCRIBE_SECRET",
  "NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "NUSEND_R2_SECRET_ACCESS_KEY",
  "NUSEND_RESTIC_PASSWORD",
] as const);

export const SECRET_ENV_KEY_SET: ReadonlySet<string> = new Set(SECRET_ENV_KEYS);

/** Non-secret + secret deployment.env keys from the production contract (ordered). */
export const DEPLOYMENT_ENV_KEYS = Object.freeze([
  "NUSEND_DOMAIN",
  "NUSEND_INGRESS_MODE",
  "NUSEND_OWNER_EMAIL",
  "NUSEND_OWNER_NAME",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "NUSEND_API_KEY_HASH_SECRET",
  "NUSEND_UNSUBSCRIBE_SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "NUSEND_SES_FROM_EMAIL",
  "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET",
  "NUSEND_SES_MARKETING_CONFIGURATION_SET",
  "NUSEND_SES_FEEDBACK_TOPIC_ARNS",
  "NUSEND_SES_TRACKING_EVENTS",
  "NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN",
  "NUSEND_RESTIC_REPOSITORY",
  "NUSEND_R2_ACCESS_KEY_ID",
  "NUSEND_R2_SECRET_ACCESS_KEY",
  "NUSEND_RESTIC_PASSWORD",
] as const);

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];
export type DeploymentEnvKey = (typeof DEPLOYMENT_ENV_KEYS)[number];
