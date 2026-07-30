import { Effect, Schema } from "effect";

import { AwsCommandError } from "./errors.ts";

/** Loose but required object boundary for AWS JSON blobs. */
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

export const CreateChangeSetResultSchema = Schema.Struct({
  Id: Schema.optional(Schema.String),
  ChangeSetId: Schema.optional(Schema.String),
  StackId: Schema.optional(Schema.String),
});

export const DescribeStacksResultSchema = Schema.Struct({
  Stacks: Schema.optional(Schema.Array(UnknownRecord)),
});

export const ChangeSetDescriptionSchema = Schema.Struct({
  Status: Schema.optional(Schema.String),
  StatusReason: Schema.optional(Schema.String),
  ExecutionStatus: Schema.optional(Schema.String),
  ChangeSetId: Schema.optional(Schema.String),
  ChangeSetName: Schema.optional(Schema.String),
  StackId: Schema.optional(Schema.String),
  StackName: Schema.optional(Schema.String),
  Capabilities: Schema.optional(Schema.Array(Schema.Unknown)),
  Changes: Schema.optional(Schema.Array(Schema.Unknown)),
});

export const StackEventsResultSchema = Schema.Struct({
  StackEvents: Schema.optional(Schema.Array(UnknownRecord)),
});

export const SesEmailIdentitySchema = Schema.Struct({
  VerificationStatus: Schema.optional(Schema.String),
  VerifiedForSendingStatus: Schema.optional(Schema.Boolean),
  DkimAttributes: Schema.optional(UnknownRecord),
});

export const SesAccountSchema = Schema.Struct({
  ProductionAccessEnabled: Schema.optional(Schema.Boolean),
  SendingEnabled: Schema.optional(Schema.Boolean),
  Details: Schema.optional(UnknownRecord),
});

export const IamListAccessKeysSchema = Schema.Struct({
  AccessKeyMetadata: Schema.optional(Schema.Array(UnknownRecord)),
});

export const IamCreateAccessKeySchema = Schema.Struct({
  AccessKey: Schema.optional(
    Schema.Struct({
      AccessKeyId: Schema.optional(Schema.String),
      SecretAccessKey: Schema.optional(Schema.String),
    }),
  ),
  AccessKeyId: Schema.optional(Schema.String),
  SecretAccessKey: Schema.optional(Schema.String),
});

export const SnsSubscriptionsResultSchema = Schema.Struct({
  Subscriptions: Schema.optional(Schema.Array(UnknownRecord)),
  NextToken: Schema.optional(Schema.String),
});

export const SnsSubscriptionAttributesResultSchema = Schema.Struct({
  Attributes: Schema.optional(UnknownRecord),
});

export function parseJsonStdout(
  stdout: string,
  operation: string,
): Effect.Effect<unknown, AwsCommandError> {
  try {
    return Effect.succeed(JSON.parse(stdout));
  } catch (cause) {
    return Effect.fail(
      new AwsCommandError({
        message: `${operation} returned malformed JSON.`,
        reason: "malformed-json",
        operation,
        stdout,
        cause,
      }),
    );
  }
}

export function decodeAwsJson<S extends Schema.Top>(
  schema: S,
  stdout: string,
  operation: string,
): Effect.Effect<S["Type"], AwsCommandError> {
  return Effect.gen(function* () {
    const parsed = yield* parseJsonStdout(stdout, operation);
    // Boundary schemas here declare no decoding services; cast keeps the error channel exact.
    return yield* (
      Schema.decodeUnknownEffect(schema)(parsed, { errors: "all" }) as Effect.Effect<
        S["Type"],
        unknown
      >
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AwsCommandError({
            message: `${operation} JSON failed schema validation.`,
            reason: "schema",
            operation,
            stdout,
            cause,
          }),
      ),
    );
  });
}

export function classifyAwsCliFailureText(text: string): AwsCommandError["reason"] | null {
  if (
    /token has expired|refresh failed|Error when retrieving token from sso|sso session .* expired|Session token not found|Token is expired|To refresh this SSO session/iu.test(
      text,
    )
  ) {
    return "expired-session";
  }
  if (/AccessDenied|UnauthorizedOperation|not authorized to perform/iu.test(text)) {
    return "access-denied";
  }
  if (/Throttl|Rate exceeded|RequestLimitExceeded|TooManyRequests|SlowDown/iu.test(text)) {
    return "throttling";
  }
  if (/timed out|timeout|Timeout/iu.test(text)) {
    return "timeout";
  }
  if (/does not exist/iu.test(text)) {
    return "not-found";
  }
  return null;
}
