import { Clock, Effect } from "effect";

import { SetupStoreError } from "../errors.ts";
import type { AwsSsoAuth, SetupState, SetupStateV1, SetupStateV2 } from "./schema.ts";
import { decodeAwsSsoAuth, decodeSetupState } from "./schema.ts";

/**
 * Verified modern SSO binding supplied by the auth wizard (T3) before migration.
 * Workload/SES region stays in installation config; Identity Center region is separate.
 */
export type SsoMigrationBinding = {
  readonly type: "sso";
  readonly profileName: string;
  readonly ssoSessionName: string;
  readonly accountId: string;
  readonly roleName: string;
  readonly identityCenterRegion: string;
  readonly partition: string;
  /** STS get-caller-identity account that must match stack/config context. */
  readonly verifiedAccountId: string;
  /** Workload region selected for this installation; must match config.awsRegion. */
  readonly workloadRegion: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readStackContext(state: SetupStateV1): {
  readonly accountId: string | null;
  readonly region: string | null;
} {
  const stack = asRecord(state.aws?.stack);
  const accountId =
    typeof stack?.accountId === "string" && stack.accountId.trim() !== ""
      ? stack.accountId.trim()
      : null;
  const region =
    typeof stack?.region === "string" && stack.region.trim() !== "" ? stack.region.trim() : null;
  return { accountId, region };
}

/**
 * Migrate schema v1 → v2 after modern SSO profile reselection/verification.
 * Preserves all stage/plan/AWS/deploy evidence. Never downgrades. Never migrates
 * static/legacy credential sources silently. Refuses wrong-context bindings.
 */
export function migrateV1ToV2(
  state: SetupState,
  binding: SsoMigrationBinding,
): Effect.Effect<SetupStateV2, SetupStoreError> {
  return Effect.gen(function* () {
    if (state.schemaVersion === 2) {
      return yield* Effect.fail(
        new SetupStoreError({
          message: "State is already schema v2; refusing re-migration or downgrade.",
          reason: "migration",
        }),
      );
    }
    if (state.schemaVersion !== 1) {
      return yield* Effect.fail(
        new SetupStoreError({
          message: `Cannot migrate unsupported schema version ${String((state as SetupState).schemaVersion)}.`,
          reason: "version",
        }),
      );
    }

    if (binding.type !== "sso") {
      return yield* Effect.fail(
        new SetupStoreError({
          message: 'Refusing migration: only modern type "sso" bindings are accepted.',
          reason: "migration",
        }),
      );
    }

    const v1 = state as SetupStateV1;

    if (binding.verifiedAccountId !== binding.accountId) {
      return yield* Effect.fail(
        new SetupStoreError({
          message: `Refusing migration: STS verified account ${binding.verifiedAccountId} does not match profile account ${binding.accountId}.`,
          reason: "migration",
        }),
      );
    }

    if (binding.verifiedAccountId !== v1.config.awsAccountId) {
      return yield* Effect.fail(
        new SetupStoreError({
          message: `Refusing migration: STS account ${binding.verifiedAccountId} does not match installation config.awsAccountId ${v1.config.awsAccountId}.`,
          reason: "migration",
        }),
      );
    }

    if (binding.workloadRegion !== v1.config.awsRegion) {
      return yield* Effect.fail(
        new SetupStoreError({
          message: `Refusing migration: workload region ${binding.workloadRegion} does not match installation config.awsRegion ${v1.config.awsRegion}.`,
          reason: "migration",
        }),
      );
    }

    const stackContext = readStackContext(v1);
    if (stackContext.accountId != null && stackContext.accountId !== binding.verifiedAccountId) {
      return yield* Effect.fail(
        new SetupStoreError({
          message: `Refusing migration: STS account ${binding.verifiedAccountId} does not match immutable stack account ${stackContext.accountId}.`,
          reason: "migration",
        }),
      );
    }
    if (stackContext.region != null && stackContext.region !== binding.workloadRegion) {
      return yield* Effect.fail(
        new SetupStoreError({
          message: `Refusing migration: workload region ${binding.workloadRegion} does not match immutable stack region ${stackContext.region}.`,
          reason: "migration",
        }),
      );
    }

    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();

    const awsAuthInput: AwsSsoAuth = {
      type: "sso",
      profileName: binding.profileName,
      ssoSessionName: binding.ssoSessionName,
      accountId: binding.accountId,
      roleName: binding.roleName,
      identityCenterRegion: binding.identityCenterRegion,
      partition: binding.partition,
      verifiedAccountId: binding.verifiedAccountId,
      verifiedAt: now,
      boundAt: now,
    };

    const awsAuth = yield* decodeAwsSsoAuth(awsAuthInput);

    const candidate: SetupStateV2 = {
      schemaVersion: 2,
      installationId: v1.installationId,
      createdAt: v1.createdAt,
      updatedAt: now,
      config: {
        ...v1.config,
        // Keep workload region explicit in config; align profile label with SSO binding.
        awsProfile: awsAuth.profileName,
        awsAccountId: awsAuth.verifiedAccountId,
        awsRegion: binding.workloadRegion,
      },
      stages: v1.stages,
      plans: v1.plans,
      ...(v1.aws ? { aws: v1.aws } : {}),
      ...(v1.deploy ? { deploy: v1.deploy } : {}),
      awsAuth,
    };

    const decoded = yield* decodeSetupState(candidate);
    if (decoded.schemaVersion !== 2) {
      return yield* Effect.fail(
        new SetupStoreError({
          message: "Migration failed to produce schema v2 state.",
          reason: "migration",
        }),
      );
    }
    return decoded;
  });
}
