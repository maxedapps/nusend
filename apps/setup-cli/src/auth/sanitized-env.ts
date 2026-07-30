/**
 * One sanitized child environment for every AWS discovery/auth/provider command.
 *
 * Deny ambient credentials, profile selection, endpoint overrides, and IMDS.
 * Preserve only reviewed config-path / CA settings needed for SSO file lookup.
 */

/** Exact AWS_* keys stripped from the child environment. */
export const AWS_ENV_DENY_EXACT = Object.freeze([
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ENDPOINT_URL",
  // Prefer explicit --region; never inherit ambient region selection for provider calls.
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  // Credential file / process ambient sources.
  "AWS_CREDENTIAL_EXPIRATION",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_EC2_METADATA_V1_DISABLED",
  "AWS_METADATA_SERVICE_TIMEOUT",
  "AWS_METADATA_SERVICE_NUM_ATTEMPTS",
] as const);

/** Exact AWS_* keys allowed through (config path + CA only). */
export const AWS_ENV_ALLOW_EXACT = Object.freeze([
  "AWS_CONFIG_FILE",
  "AWS_CA_BUNDLE",
  "AWS_CA_BUNDLE_NAME",
] as const);

const ALLOW_SET: ReadonlySet<string> = new Set(AWS_ENV_ALLOW_EXACT);
const DENY_SET: ReadonlySet<string> = new Set(AWS_ENV_DENY_EXACT);

export type ProcessEnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Build the sanitized AWS child env from a parent env snapshot.
 * Always forces credentials file null, IMDS off, and configured endpoint ignore.
 */
export function buildSanitizedAwsEnv(
  parentEnv: ProcessEnvLike = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value == null) continue;
    if (key.startsWith("AWS_")) {
      if (ALLOW_SET.has(key)) {
        out[key] = value;
        continue;
      }
      // Deny AWS_ENDPOINT_URL and every AWS_ENDPOINT_URL_* service override.
      if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_")) continue;
      if (DENY_SET.has(key)) continue;
      // Any other AWS_* ambient var is denied (fail closed).
      continue;
    }
    out[key] = value;
  }

  out.AWS_SHARED_CREDENTIALS_FILE = "/dev/null";
  out.AWS_EC2_METADATA_DISABLED = "true";
  out.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";

  // Ensure denied keys cannot linger if parent used unusual casing (env keys are exact).
  for (const denied of AWS_ENV_DENY_EXACT) {
    if (denied === "AWS_SHARED_CREDENTIALS_FILE") continue;
    delete out[denied];
  }
  for (const key of Object.keys(out)) {
    if (key.startsWith("AWS_ENDPOINT_URL")) delete out[key];
  }

  return out;
}

/** True when a key is forbidden in the sanitized AWS child environment. */
export function isDeniedAwsEnvKey(key: string): boolean {
  if (key === "AWS_ENDPOINT_URL" || key.startsWith("AWS_ENDPOINT_URL_")) return true;
  if (!key.startsWith("AWS_")) return false;
  if (ALLOW_SET.has(key)) return false;
  if (DENY_SET.has(key)) return true;
  // Forced overrides are set by us, not ambient allow.
  if (
    key === "AWS_SHARED_CREDENTIALS_FILE" ||
    key === "AWS_EC2_METADATA_DISABLED" ||
    key === "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS"
  ) {
    return false;
  }
  return true;
}
