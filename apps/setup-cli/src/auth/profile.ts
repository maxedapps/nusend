import { Effect, Result } from "effect";

import { AwsAuthError, CancellationError } from "../errors.ts";
import type { AwsCliService } from "./aws-cli.ts";

/** Modern refreshable IAM Identity Center profile fields. */
export type ModernSsoProfile = {
  readonly profileName: string;
  readonly ssoSessionName: string;
  readonly accountId: string;
  readonly roleName: string;
  readonly identityCenterRegion: string;
  /** Optional workload default region from the profile (not Identity Center region). */
  readonly profileRegion: string | null;
};

const REJECTED_PROFILE_KEYS = Object.freeze([
  "credential_process",
  "credential_source",
  "role_arn",
  "source_profile",
  "aws_access_key_id",
  "aws_secret_access_key",
  "aws_session_token",
  "web_identity_token_file",
  "login_session",
  "external_id",
  "mfa_serial",
  "credential_account_id",
] as const);

export type ProfileConfigMap = Readonly<Record<string, string | null>>;

/**
 * Classify profile config from `aws configure get` results.
 * Requires modern sso_session + account + role; rejects legacy/static/chain sources.
 */
export function classifyModernSsoProfile(
  profileName: string,
  config: ProfileConfigMap,
  sessionRegion: string | null,
): Effect.Effect<ModernSsoProfile, AwsAuthError> {
  for (const key of REJECTED_PROFILE_KEYS) {
    const value = config[key];
    if (value != null && String(value).trim() !== "") {
      return Effect.fail(
        new AwsAuthError({
          message: `Profile "${profileName}" uses rejected credential source "${key}". Setup requires a modern IAM Identity Center (sso_session) profile only.`,
          reason: "rejected-credential-source",
        }),
      );
    }
  }

  const ssoSessionName = trimOrNull(config.sso_session);
  const accountId = trimOrNull(config.sso_account_id);
  const roleName = trimOrNull(config.sso_role_name);
  const legacyStartUrl = trimOrNull(config.sso_start_url);
  const profileRegion = trimOrNull(config.region);

  if (legacyStartUrl != null && ssoSessionName == null) {
    return Effect.fail(
      new AwsAuthError({
        message: `Profile "${profileName}" is legacy sso_start_url-only (non-refreshable). Reconfigure with a modern sso_session profile.`,
        reason: "rejected-credential-source",
      }),
    );
  }

  if (ssoSessionName == null || accountId == null || roleName == null) {
    return Effect.fail(
      new AwsAuthError({
        message: `Profile "${profileName}" is not a modern SSO profile (need sso_session, sso_account_id, sso_role_name).`,
        reason: "invalid-profile",
      }),
    );
  }

  if (!/^\d{12}$/u.test(accountId)) {
    return Effect.fail(
      new AwsAuthError({
        message: `Profile "${profileName}" has invalid sso_account_id "${accountId}".`,
        reason: "invalid-profile",
      }),
    );
  }

  const identityCenterRegion = trimOrNull(sessionRegion) ?? trimOrNull(config.sso_region);
  if (identityCenterRegion == null) {
    return Effect.fail(
      new AwsAuthError({
        message: `Profile "${profileName}" SSO session "${ssoSessionName}" is missing sso_region (Identity Center region).`,
        reason: "invalid-profile",
      }),
    );
  }

  return Effect.succeed({
    profileName,
    ssoSessionName,
    accountId,
    roleName,
    identityCenterRegion,
    profileRegion,
  });
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

export function parseListProfiles(stdout: string): readonly string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * `aws configure list` must show SSO provenance for access key material.
 * Never treats static/env/shared-credentials/IMDS as acceptable.
 */
export function assertSsoProvenance(
  profileName: string,
  configureListText: string,
): Effect.Effect<void, AwsAuthError> {
  const text = configureListText;
  const lower = text.toLowerCase();

  // Reject ambient/static sources appearing in the listing.
  const rejectedType = [
    "shared-credentials-file",
    "env",
    "environment",
    "imds",
    "metadata",
    "assume-role",
    "credential-process",
    "web-identity",
    "login",
  ];
  for (const bad of rejectedType) {
    // Match TYPE column tokens near access_key / secret_key rows.
    if (
      new RegExp(
        `(?:access_key|secret_key|session_token)\\s*:\\s*\\S*\\s*:\\s*${bad}\\b`,
        "iu",
      ).test(text)
    ) {
      return Effect.fail(
        new AwsAuthError({
          message: `Profile "${profileName}" credential provenance is "${bad}", not SSO. Setup requires modern IAM Identity Center credentials.`,
          reason: "provenance",
        }),
      );
    }
  }

  const hasSsoType =
    /(?:access_key|secret_key)\s*:[^:\n]*:\s*sso\b/iu.test(text) || /\bsso\b/iu.test(lower);
  if (!hasSsoType) {
    return Effect.fail(
      new AwsAuthError({
        message: `Profile "${profileName}" did not report SSO credential provenance via aws configure list.`,
        reason: "provenance",
      }),
    );
  }

  return Effect.succeed(undefined);
}

const PROFILE_CONFIG_KEYS = [
  "sso_session",
  "sso_account_id",
  "sso_role_name",
  "sso_start_url",
  "sso_region",
  "region",
  ...REJECTED_PROFILE_KEYS,
] as const;

/**
 * Load and classify a single named profile through AwsCli configure gets.
 */
export function loadModernSsoProfile(
  aws: AwsCliService,
  profileName: string,
): Effect.Effect<ModernSsoProfile, AwsAuthError | CancellationError> {
  return Effect.gen(function* () {
    const config: Record<string, string | null> = {};
    for (const key of PROFILE_CONFIG_KEYS) {
      config[key] = yield* aws.configureGet(profileName, key);
    }

    const sessionName = trimOrNull(config.sso_session);
    let sessionRegion: string | null = null;
    if (sessionName != null) {
      sessionRegion = yield* aws.configureGetSsoSession(sessionName, "sso_region");
      // Optional: reject session-level legacy-only fields is already covered by needing sso_session.
    }

    return yield* classifyModernSsoProfile(profileName, config, sessionRegion);
  });
}

/**
 * Discover all modern SSO profiles available on this workstation.
 * Non-modern profiles are skipped (not fatal).
 */
export function discoverModernSsoProfiles(
  aws: AwsCliService,
): Effect.Effect<readonly ModernSsoProfile[], AwsAuthError | CancellationError> {
  return Effect.gen(function* () {
    const names = yield* aws.listProfiles();
    const modern: ModernSsoProfile[] = [];
    for (const name of names) {
      const result = yield* loadModernSsoProfile(aws, name).pipe(Effect.result);
      if (Result.isSuccess(result)) {
        modern.push(result.success);
      }
      // Skip rejected/invalid candidates silently during discovery.
    }
    return modern;
  });
}

/** Conservative profile + sso-session names for a new configure sso flow. */
export function generateSsoNames(installationId: string): {
  readonly profileName: string;
  readonly sessionHint: string;
} {
  const slug = installationId
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 24);
  const base = slug.length > 0 ? slug : "install";
  return {
    profileName: `nusend-${base}`,
    sessionHint: `nusend-${base}-sso`,
  };
}
