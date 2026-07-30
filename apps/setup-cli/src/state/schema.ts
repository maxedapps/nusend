import { Effect, Schema, SchemaGetter } from "effect";

import { SetupStoreError } from "../errors.ts";
import {
  AWS_ACCOUNT_ID_PATTERN,
  CURRENT_POINTER_NAME,
  INSTALLATION_ID_PATTERN,
  PROVISIONER_POLICY_FILE_NAME,
  RELEASE_TAG_PATTERN,
} from "./constants.ts";
import { sanitizePlanMetadata } from "./sanitize.ts";

const TrimmedNonEmpty = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value: string) => value.trim()),
    encode: SchemaGetter.passthrough(),
  }),
).check(Schema.isMinLength(1));

const InstallationIdSchema = TrimmedNonEmpty.check(
  Schema.makeFilter<string>(
    (value) =>
      (INSTALLATION_ID_PATTERN.test(value) && value !== CURRENT_POINTER_NAME) ||
      `Invalid installation id "${value}". Use a conservative slug: lowercase letter, then 0-30 lowercase letters, digits, or hyphens (max 31 characters).`,
  ),
);

const ReleaseTagSchema = Schema.String.check(
  Schema.makeFilter<string>(
    (value) =>
      RELEASE_TAG_PATTERN.test(value) ||
      `Invalid release tag "${value}". Expected a conservative tag like v1.2.3.`,
  ),
);

const AwsAccountIdSchema = TrimmedNonEmpty.check(
  Schema.makeFilter<string>(
    (value) => AWS_ACCOUNT_ID_PATTERN.test(value) || "must be a 12-digit AWS account id.",
  ),
);

const AbsolutePosixPathSchema = Schema.String.check(
  Schema.makeFilter<string>((path) => {
    if (!path.startsWith("/") || path.includes("\0")) {
      return `Remote path must be an absolute POSIX path (got "${path}").`;
    }
    if (path.includes("//") || path.split("/").some((part) => part === "." || part === "..")) {
      return `Remote path must not contain relative segments (got "${path}").`;
    }
    return true;
  }),
);

export const SetupStateConfigSchema = Schema.Struct({
  releaseTag: ReleaseTagSchema,
  domain: TrimmedNonEmpty,
  ingressMode: Schema.Literals(["direct", "cloudflare"]),
  ownerEmail: TrimmedNonEmpty,
  ownerName: TrimmedNonEmpty,
  awsProfile: TrimmedNonEmpty,
  awsRegion: TrimmedNonEmpty,
  awsAccountId: AwsAccountIdSchema,
  sesIdentity: TrimmedNonEmpty,
  sesFromEmail: TrimmedNonEmpty,
  marketingEnabled: Schema.Boolean,
  trackingEnabled: Schema.Boolean,
  alertEmail: TrimmedNonEmpty,
  route53HostedZoneId: Schema.NullOr(TrimmedNonEmpty),
  sshTarget: TrimmedNonEmpty,
  remotePath: AbsolutePosixPathSchema,
  installationName: Schema.optional(TrimmedNonEmpty),
});

export type SetupStateConfig = typeof SetupStateConfigSchema.Type;

/** Non-secret modern SSO binding. No tokens/device codes/credentials. */
export const AwsSsoAuthSchema = Schema.Struct({
  type: Schema.Literal("sso"),
  profileName: TrimmedNonEmpty,
  ssoSessionName: TrimmedNonEmpty,
  accountId: AwsAccountIdSchema,
  roleName: TrimmedNonEmpty,
  identityCenterRegion: TrimmedNonEmpty,
  partition: TrimmedNonEmpty,
  verifiedAccountId: AwsAccountIdSchema,
  verifiedAt: TrimmedNonEmpty,
  boundAt: TrimmedNonEmpty,
});

export type AwsSsoAuth = typeof AwsSsoAuthSchema.Type;

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const StageCheckpointSchema = Schema.Struct({
  status: Schema.Literal("complete"),
  completedAt: Schema.String,
  evidence: UnknownRecordSchema,
});

export type StageCheckpoint = typeof StageCheckpointSchema.Type;

const SetupAwsStateSchema = Schema.Struct({
  stack: Schema.optional(UnknownRecordSchema),
  stackCreation: Schema.optional(UnknownRecordSchema),
  runtimeAccessKeyId: Schema.optional(TrimmedNonEmpty),
  productionAccess: Schema.optional(UnknownRecordSchema),
  identity: Schema.optional(UnknownRecordSchema),
});

export type SetupAwsState = typeof SetupAwsStateSchema.Type;

/** Non-secret metadata for the importable setup-provisioner policy artifact. */
export const ProvisionerPolicyRecordSchema = Schema.Struct({
  fileName: Schema.Literal(PROVISIONER_POLICY_FILE_NAME),
  fingerprintSha256: TrimmedNonEmpty,
  generatedAt: TrimmedNonEmpty,
  partition: TrimmedNonEmpty,
  accountId: AwsAccountIdSchema,
  region: TrimmedNonEmpty,
  installationId: InstallationIdSchema,
  installationName: TrimmedNonEmpty,
  stackName: TrimmedNonEmpty,
  route53HostedZoneId: Schema.NullOr(TrimmedNonEmpty),
  dedicatedTemporaryAssignment: Schema.optionalKey(Schema.Boolean),
});

export type ProvisionerPolicyRecord = typeof ProvisionerPolicyRecordSchema.Type;

const StagesSchema = Schema.optionalKey(
  Schema.NullOr(Schema.Record(Schema.String, StageCheckpointSchema)),
);
const PlansSchema = Schema.optionalKey(
  Schema.NullOr(Schema.Record(Schema.String, UnknownRecordSchema)),
);

const SetupStateBaseFields = {
  installationId: InstallationIdSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  config: SetupStateConfigSchema,
  stages: StagesSchema,
  plans: PlansSchema,
  aws: Schema.optional(SetupAwsStateSchema),
  deploy: Schema.optional(UnknownRecordSchema),
  provisionerPolicy: Schema.optional(ProvisionerPolicyRecordSchema),
} as const;

export const SetupStateV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  ...SetupStateBaseFields,
});

export const SetupStateV2Schema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  ...SetupStateBaseFields,
  awsAuth: AwsSsoAuthSchema,
});

export const SetupStateSchema = Schema.Union([SetupStateV1Schema, SetupStateV2Schema]);

/** Domain state after decode + sanitize (stages/plans always present). */
export type SetupStateV1 = {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly config: SetupStateConfig;
  readonly stages: Record<string, StageCheckpoint>;
  readonly plans: Record<string, Record<string, unknown>>;
  readonly aws?: SetupAwsState;
  readonly deploy?: Record<string, unknown>;
  readonly provisionerPolicy?: ProvisionerPolicyRecord;
};

export type SetupStateV2 = {
  readonly schemaVersion: 2;
  readonly installationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly config: SetupStateConfig;
  readonly stages: Record<string, StageCheckpoint>;
  readonly plans: Record<string, Record<string, unknown>>;
  readonly aws?: SetupAwsState;
  readonly deploy?: Record<string, unknown>;
  readonly provisionerPolicy?: ProvisionerPolicyRecord;
  readonly awsAuth: AwsSsoAuth;
};

export type SetupState = SetupStateV1 | SetupStateV2;

function mapSchemaError(error: unknown, label: string): SetupStoreError {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  const versionFailure = /schemaVersion|Unsupported state schema version|Literal/i.test(message);
  return new SetupStoreError({
    message: `${label}: ${message}`,
    reason: versionFailure ? "version" : "parse",
    cause: error,
  });
}

function finalizeParsedState(state: typeof SetupStateSchema.Type): SetupState {
  const stages: Record<string, StageCheckpoint> = {};
  for (const [name, checkpoint] of Object.entries(state.stages ?? {})) {
    const evidence = sanitizePlanMetadata(checkpoint.evidence as Record<string, unknown>);
    if (evidence.verified !== true) {
      throw new SetupStoreError({
        message: `state.json stages.${name}.evidence.verified must be true (exit status alone is not evidence).`,
        reason: "parse",
      });
    }
    stages[name] = {
      status: "complete",
      completedAt: checkpoint.completedAt,
      evidence,
    };
  }

  const plans: Record<string, Record<string, unknown>> = {};
  for (const [name, plan] of Object.entries(state.plans ?? {})) {
    plans[name] = sanitizePlanMetadata(plan as Record<string, unknown>);
  }

  const aws = state.aws
    ? sanitizeAwsState(state.aws as SetupAwsState & Record<string, unknown>)
    : undefined;
  const deploy = state.deploy
    ? sanitizePlanMetadata(state.deploy as Record<string, unknown>)
    : undefined;

  const provisionerPolicy = state.provisionerPolicy
    ? sanitizeProvisionerPolicy(state.provisionerPolicy)
    : undefined;

  if (state.schemaVersion === 2) {
    return {
      schemaVersion: 2,
      installationId: state.installationId,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      config: state.config,
      stages,
      plans,
      ...(aws ? { aws } : {}),
      ...(deploy ? { deploy } : {}),
      ...(provisionerPolicy ? { provisionerPolicy } : {}),
      awsAuth: state.awsAuth,
    };
  }

  return {
    schemaVersion: 1,
    installationId: state.installationId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    config: state.config,
    stages,
    plans,
    ...(aws ? { aws } : {}),
    ...(deploy ? { deploy } : {}),
    ...(provisionerPolicy ? { provisionerPolicy } : {}),
  };
}

function sanitizeProvisionerPolicy(record: ProvisionerPolicyRecord): ProvisionerPolicyRecord {
  // Record is already schema-validated; drop any unexpected secret-shaped extras by re-picking.
  return {
    fileName: record.fileName,
    fingerprintSha256: record.fingerprintSha256,
    generatedAt: record.generatedAt,
    partition: record.partition,
    accountId: record.accountId,
    region: record.region,
    installationId: record.installationId,
    installationName: record.installationName,
    stackName: record.stackName,
    route53HostedZoneId: record.route53HostedZoneId,
    ...(record.dedicatedTemporaryAssignment === undefined
      ? {}
      : { dedicatedTemporaryAssignment: record.dedicatedTemporaryAssignment }),
  };
}

function sanitizeAwsState(raw: SetupAwsState & Record<string, unknown>): SetupAwsState {
  const sanitized = sanitizePlanMetadata(raw);
  let stack: Record<string, unknown> | undefined;
  let stackCreation: Record<string, unknown> | undefined;
  let runtimeAccessKeyId: string | undefined;
  let productionAccess: Record<string, unknown> | undefined;
  let identity: Record<string, unknown> | undefined;

  if (sanitized.stack !== undefined) {
    if (
      sanitized.stack == null ||
      typeof sanitized.stack !== "object" ||
      Array.isArray(sanitized.stack)
    ) {
      throw new SetupStoreError({
        message: "state.json aws.stack must be an object when present.",
        reason: "parse",
      });
    }
    stack = sanitized.stack as Record<string, unknown>;
  }
  if (sanitized.stackCreation !== undefined) {
    if (
      sanitized.stackCreation == null ||
      typeof sanitized.stackCreation !== "object" ||
      Array.isArray(sanitized.stackCreation)
    ) {
      throw new SetupStoreError({
        message: "state.json aws.stackCreation must be an object when present.",
        reason: "parse",
      });
    }
    stackCreation = sanitized.stackCreation as Record<string, unknown>;
  }
  if (sanitized.runtimeAccessKeyId !== undefined) {
    if (
      typeof sanitized.runtimeAccessKeyId !== "string" ||
      sanitized.runtimeAccessKeyId.trim() === ""
    ) {
      throw new SetupStoreError({
        message: "state.json aws.runtimeAccessKeyId must be a non-empty string when present.",
        reason: "parse",
      });
    }
    runtimeAccessKeyId = sanitized.runtimeAccessKeyId.trim();
  }
  if (sanitized.productionAccess !== undefined) {
    if (
      sanitized.productionAccess == null ||
      typeof sanitized.productionAccess !== "object" ||
      Array.isArray(sanitized.productionAccess)
    ) {
      throw new SetupStoreError({
        message: "state.json aws.productionAccess must be an object when present.",
        reason: "parse",
      });
    }
    productionAccess = sanitized.productionAccess as Record<string, unknown>;
  }
  if (sanitized.identity !== undefined) {
    if (
      sanitized.identity == null ||
      typeof sanitized.identity !== "object" ||
      Array.isArray(sanitized.identity)
    ) {
      throw new SetupStoreError({
        message: "state.json aws.identity must be an object when present.",
        reason: "parse",
      });
    }
    identity = sanitized.identity as Record<string, unknown>;
  }

  return {
    ...(stack ? { stack } : {}),
    ...(stackCreation ? { stackCreation } : {}),
    ...(runtimeAccessKeyId ? { runtimeAccessKeyId } : {}),
    ...(productionAccess ? { productionAccess } : {}),
    ...(identity ? { identity } : {}),
  };
}

/**
 * Decode unknown JSON into a validated SetupState (v1 or v2).
 * Sanitizes plan/stage/aws metadata; never keeps secret-shaped keys.
 */
export function decodeSetupState(value: unknown): Effect.Effect<SetupState, SetupStoreError> {
  return Schema.decodeUnknownEffect(SetupStateSchema)(value, { errors: "all" }).pipe(
    Effect.mapError((error) => mapSchemaError(error, "state.json")),
    Effect.flatMap((state) =>
      Effect.try({
        try: () => finalizeParsedState(state),
        catch: (error) =>
          error instanceof SetupStoreError
            ? error
            : new SetupStoreError({
                message: error instanceof Error ? error.message : String(error),
                reason: "parse",
                cause: error,
              }),
      }),
    ),
  );
}

export function decodeAwsSsoAuth(value: unknown): Effect.Effect<AwsSsoAuth, SetupStoreError> {
  return Schema.decodeUnknownEffect(AwsSsoAuthSchema)(value, { errors: "all" }).pipe(
    Effect.mapError((error) => mapSchemaError(error, "awsAuth")),
  );
}

/** Encode state for atomic JSON write (already-validated domain value). */
export function encodeSetupStateJson(state: SetupState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function assertReleaseTag(tag: string): string {
  if (typeof tag !== "string" || !RELEASE_TAG_PATTERN.test(tag)) {
    throw new SetupStoreError({
      message: `Invalid release tag "${tag}". Expected a conservative tag like v1.2.3.`,
      reason: "invalid-input",
    });
  }
  return tag;
}

export function assertAbsolutePosixPath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw new SetupStoreError({
      message: `Remote path must be an absolute POSIX path (got "${path}").`,
      reason: "invalid-input",
    });
  }
  if (path.includes("//") || path.split("/").some((part) => part === "." || part === "..")) {
    throw new SetupStoreError({
      message: `Remote path must not contain relative segments (got "${path}").`,
      reason: "invalid-input",
    });
  }
  return path;
}
