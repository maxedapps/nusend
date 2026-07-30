import { Effect, Schema } from "effect";

import { AwsAuthError } from "../errors.ts";

/** Schema-decoded STS get-caller-identity JSON (no credentials). */
export const StsCallerIdentitySchema = Schema.Struct({
  Account: Schema.String,
  Arn: Schema.String,
  UserId: Schema.optional(Schema.String),
});

export type StsCallerIdentity = typeof StsCallerIdentitySchema.Type;

export type ResolvedCallerContext = {
  readonly accountId: string;
  readonly arn: string;
  readonly partition: string;
  readonly roleName: string | null;
  readonly userId: string | null;
};

export function decodeStsCallerIdentity(
  stdout: string,
): Effect.Effect<StsCallerIdentity, AwsAuthError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    return Effect.fail(
      new AwsAuthError({
        message: "sts get-caller-identity returned malformed JSON.",
        reason: "malformed-identity",
        cause,
      }),
    );
  }
  return Schema.decodeUnknownEffect(StsCallerIdentitySchema)(parsed, { errors: "all" }).pipe(
    Effect.mapError(
      (cause) =>
        new AwsAuthError({
          message: "sts get-caller-identity JSON failed schema validation.",
          reason: "malformed-identity",
          cause,
        }),
    ),
  );
}

export function resolveCallerFromIdentity(
  identity: StsCallerIdentity,
): Effect.Effect<ResolvedCallerContext, AwsAuthError> {
  const accountId = identity.Account.trim();
  const arn = identity.Arn.trim();
  if (!/^\d{12}$/u.test(accountId)) {
    return Effect.fail(
      new AwsAuthError({
        message: "STS caller identity did not return a 12-digit account id.",
        reason: "malformed-identity",
      }),
    );
  }
  if (!arn.startsWith("arn:")) {
    return Effect.fail(
      new AwsAuthError({
        message: "STS caller identity ARN is missing or malformed.",
        reason: "malformed-identity",
      }),
    );
  }
  const partition = arn.split(":")[1] || "aws";
  return Effect.succeed({
    accountId,
    arn,
    partition,
    roleName: roleNameFromArn(arn),
    userId: identity.UserId?.trim() ?? null,
  });
}

/**
 * Extract a comparable role name from an STS/IAM ARN.
 * SSO assumed-role names look like AWSReservedSSO_<RoleName>_<hash>.
 */
export function roleNameFromArn(arn: string): string | null {
  const assumed = /:assumed-role\/([^/]+)\//u.exec(arn);
  if (assumed?.[1]) {
    const name = assumed[1];
    const sso = /^AWSReservedSSO_(.+)_[0-9a-fA-F]+$/u.exec(name);
    if (sso?.[1]) return sso[1];
    return name;
  }
  const role = /:role\/([^/]+)$/u.exec(arn);
  return role?.[1] ?? null;
}

/** Detect expired/missing SSO session messages from AWS CLI (not AccessDenied). */
export function isSsoSessionExpiredText(text: string): boolean {
  return (
    /token has expired/iu.test(text) ||
    /refresh failed/iu.test(text) ||
    /Error when retrieving token from sso/iu.test(text) ||
    /sso session .* expired/iu.test(text) ||
    /Session token not found/iu.test(text) ||
    /Token is expired/iu.test(text) ||
    /To refresh this SSO session/iu.test(text)
  );
}

export function isAccessDeniedText(text: string): boolean {
  return /AccessDenied|UnauthorizedOperation|not authorized to perform/iu.test(text);
}
