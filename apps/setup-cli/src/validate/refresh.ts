import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";

import { refreshProductionAccessStatus } from "../aws/identity.ts";
import {
  describeStack,
  liftProviderError,
  makeStateRunner,
  resolveCallerContext,
} from "../aws/ops.ts";
import { buildStackName, parseStackOutputs } from "../aws/pure.ts";
import { decodeAwsJson, SesEmailIdentitySchema } from "../aws/schemas.ts";
import { verifyFinalizedSubscription } from "../aws/subscription.ts";
import { validateDeployHealth } from "../deploy/index.ts";
import { SetupCommandError } from "../errors.ts";
import { redactText } from "../process-runner.ts";
import { SetupStore } from "../services/setup-store.ts";
import { secretValuesFromEnv } from "../state/env.ts";
import type { PathEnvironment } from "../state/paths.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { SetupState } from "../state/schema.ts";
import { REFRESH_PLAN_KEY } from "./constants.ts";
import {
  readDlqCounters,
  type ValidateWorkflowError,
  type ValidateWorkflowServices,
} from "./ops.ts";
import { runReadinessValidation } from "./stages.ts";

const DriftDetectSchema = Schema.Struct({
  StackDriftDetectionId: Schema.optional(Schema.String),
});

const DriftStatusSchema = Schema.Struct({
  DetectionStatus: Schema.optional(Schema.String),
  StackDriftStatus: Schema.optional(Schema.String),
});

const DriftResourcesSchema = Schema.Struct({
  StackResourceDrifts: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});

/** Opt-in provider refresh plus drift detection and sanitized local summary persistence. */
export function runProviderRefresh(
  env: PathEnvironment = process.env,
  initialState?: SetupState,
): Effect.Effect<Record<string, unknown>, ValidateWorkflowError, ValidateWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId =
      initialState?.installationId ?? (yield* store.resolveInstallationId(env));
    const state = yield* store.loadState(installationId, env);
    const nowMillis = yield* Clock.currentTimeMillis;
    const checkedAt = new Date(nowMillis).toISOString();

    const secrets = yield* store.loadDeploymentEnv(state.installationId, env).pipe(
      Effect.map((deployment) => secretValuesFromEnv(deployment)),
      Effect.catchTag("SetupStoreError", () => Effect.succeed([] as string[])),
    );

    const summary: Record<string, unknown> = { checkedAt };

    const persistSummary = Effect.gen(function* () {
      const sanitized = sanitizePlanMetadata(summary);
      const next = yield* store.loadState(state.installationId, env);
      yield* store.writeState(
        {
          ...next,
          updatedAt: checkedAt,
          plans: { ...next.plans, [REFRESH_PLAN_KEY]: sanitized },
        },
        env,
      );
      return sanitized;
    });

    const capture = <A>(
      key: string,
      fn: () => Effect.Effect<A, ValidateWorkflowError, ValidateWorkflowServices>,
    ): Effect.Effect<void, never, ValidateWorkflowServices> =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(fn());
        if (Exit.isSuccess(exit)) {
          const value = exit.value;
          summary[key] =
            value != null && typeof value === "object" && !Array.isArray(value)
              ? { status: "ok", ...(value as Record<string, unknown>) }
              : { status: "ok", value };
          return;
        }
        const typed = Cause.findErrorOption(exit.cause);
        const text = Option.isSome(typed)
          ? String((typed.value as { message?: string }).message ?? typed.value)
          : Cause.pretty(exit.cause);
        summary[key] = {
          status: "unavailable",
          message: redactText(text, secrets),
        };
      }).pipe(Effect.asVoid);

    // Caller binding is fail-closed for the whole refresh.
    {
      const callerExit = yield* Effect.exit(resolveCallerContext(state, env));
      if (Exit.isFailure(callerExit)) {
        const typed = Cause.findErrorOption(callerExit.cause);
        const msg = Option.isSome(typed)
          ? String((typed.value as { message?: string }).message ?? typed.value)
          : Cause.pretty(callerExit.cause);
        summary.caller = {
          status: "unavailable",
          message: redactText(msg, secrets),
        };
        summary.blocked = {
          status: "blocked",
          reason: "aws-caller-binding",
          message: "No further provider refresh operations were attempted.",
        };
        return yield* persistSummary;
      }
      const caller = callerExit.value;
      summary.caller = { status: "ok", accountId: caller.accountId, region: caller.region };
    }

    yield* capture("stack", () =>
      Effect.gen(function* () {
        const live = yield* describeStack(state, buildStackName(state.installationId), env);
        const outputs = live.raw
          ? parseStackOutputs(((live.raw as { Outputs?: unknown }).Outputs as unknown[]) ?? [])
          : {};
        return {
          exists: live.exists,
          stackId: live.stackId,
          stackStatus: live.status,
          outputKeys: Object.keys(outputs).sort(),
        };
      }),
    );

    yield* capture("drift", () =>
      Effect.gen(function* () {
        const run = yield* makeStateRunner(state);
        const detected = yield* run([
          "cloudformation",
          "detect-stack-drift",
          "--stack-name",
          buildStackName(state.installationId),
          "--output",
          "json",
        ]).pipe(
          Effect.catch((error) =>
            liftProviderError(state, env, "cloudformation detect-stack-drift", error),
          ),
        );
        const detection = yield* decodeAwsJson(
          DriftDetectSchema,
          detected.stdout,
          "cloudformation detect-stack-drift",
        );
        const detectionId = String(detection.StackDriftDetectionId ?? "");
        if (!detectionId) {
          return yield* Effect.fail(
            new SetupCommandError({
              message: "CloudFormation drift detection returned no id.",
            }),
          );
        }
        yield* run(
          [
            "cloudformation",
            "wait",
            "stack-drift-detection-complete",
            "--stack-drift-detection-id",
            detectionId,
          ],
          { allowNonZero: true },
        ).pipe(
          Effect.catch((error) =>
            liftProviderError(
              state,
              env,
              "cloudformation wait stack-drift-detection-complete",
              error,
            ),
          ),
        );
        const statusResult = yield* run([
          "cloudformation",
          "describe-stack-drift-detection-status",
          "--stack-drift-detection-id",
          detectionId,
          "--output",
          "json",
        ]).pipe(
          Effect.catch((error) =>
            liftProviderError(
              state,
              env,
              "cloudformation describe-stack-drift-detection-status",
              error,
            ),
          ),
        );
        const status = yield* decodeAwsJson(
          DriftStatusSchema,
          statusResult.stdout,
          "cloudformation describe-stack-drift-detection-status",
        );
        if (status.DetectionStatus !== "DETECTION_COMPLETE") {
          return yield* Effect.fail(
            new SetupCommandError({
              message: `CloudFormation drift detection did not complete (${String(status.DetectionStatus ?? "unknown")}).`,
            }),
          );
        }
        const result = yield* run([
          "cloudformation",
          "describe-stack-resource-drifts",
          "--stack-name",
          buildStackName(state.installationId),
          "--output",
          "json",
        ]).pipe(
          Effect.catch((error) =>
            liftProviderError(state, env, "cloudformation describe-stack-resource-drifts", error),
          ),
        );
        const payload = yield* decodeAwsJson(
          DriftResourcesSchema,
          result.stdout,
          "cloudformation describe-stack-resource-drifts",
        );
        const drifts = Array.isArray(payload.StackResourceDrifts)
          ? payload.StackResourceDrifts
          : [];
        return {
          stackDriftStatus: String(status.StackDriftStatus ?? "UNKNOWN"),
          resourceCount: drifts.length,
          driftedCount: drifts.filter(
            (item) =>
              item?.StackResourceDriftStatus === "MODIFIED" ||
              item?.StackResourceDriftStatus === "DELETED",
          ).length,
        };
      }),
    );

    yield* capture("ses", () =>
      Effect.gen(function* () {
        const run = yield* makeStateRunner(state);
        const identityResult = yield* run([
          "sesv2",
          "get-email-identity",
          "--email-identity",
          state.config.sesIdentity,
          "--output",
          "json",
        ]).pipe(
          Effect.catch((error) => liftProviderError(state, env, "sesv2 get-email-identity", error)),
        );
        const identity = yield* decodeAwsJson(
          SesEmailIdentitySchema,
          identityResult.stdout,
          "sesv2 get-email-identity",
        );
        const production = yield* refreshProductionAccessStatus(state, env, {
          persist: false,
        });
        return {
          verificationStatus: String(identity.VerificationStatus ?? ""),
          dkimStatus: String(
            (identity.DkimAttributes as { Status?: string } | undefined)?.Status ?? "",
          ),
          productionAccessEnabled: production.productionAccessEnabled === true,
          reviewStatus: String(production.reviewStatus ?? "UNKNOWN"),
        };
      }),
    );

    yield* capture("subscription", () =>
      Effect.gen(function* () {
        const run = yield* makeStateRunner(state);
        const value = yield* verifyFinalizedSubscription(state, run, { attempts: 1 }).pipe(
          Effect.catch((error) =>
            error instanceof SetupCommandError
              ? Effect.fail(error)
              : liftProviderError(state, env, "sns subscription", error as never),
          ),
        );
        return {
          confirmed: true,
          endpoint: value.endpoint,
          rawMessageDelivery: value.rawMessageDelivery,
          dlqArn: value.dlqArn,
        };
      }),
    );

    yield* capture("dlq", () =>
      Effect.gen(function* () {
        const run = yield* makeStateRunner(state);
        return yield* readDlqCounters(state, run).pipe(
          Effect.catch((error) =>
            error instanceof SetupCommandError
              ? Effect.fail(error)
              : liftProviderError(state, env, "sqs get-queue-attributes", error as never),
          ),
        );
      }),
    );

    yield* capture("remote", () =>
      Effect.gen(function* () {
        const deployment = yield* store.loadDeploymentEnv(state.installationId, env);
        const health = yield* validateDeployHealth(state, {
          domain: state.config.domain,
          remotePath: state.config.remotePath,
          secrets: secretValuesFromEnv(deployment),
        });
        return {
          composeHealthy: true,
          publicHealth: health.publicHealth,
          publicHealthDb: health.publicHealthDb,
          apiHealthDb: health.apiHealthDb,
        };
      }),
    );

    yield* capture("readiness", () =>
      runReadinessValidation(state, state.stages.validate_simulator?.status === "complete", env),
    );

    return yield* persistSummary;
  });
}
