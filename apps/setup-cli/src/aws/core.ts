import { Effect } from "effect";

import { askBoolean, writeLine } from "../commands/prompts.ts";
import { SetupCommandError } from "../errors.ts";
import { SetupStore } from "../services/setup-store.ts";
import { unwrapEnvValue } from "../state/env.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import type { StageHandler } from "../commands/continue.ts";
import { refreshAndStoreIdentity, refreshProductionAccessStatus } from "./identity.ts";
import {
  describeStack,
  resolveCallerContext,
  type AwsWorkflowError,
  type AwsWorkflowServices,
} from "./ops.ts";
import { runProductionAccessRequest } from "./production-access.ts";
import { buildStackName, isDkimReady, isIdentityReady } from "./pure.ts";
import { runCreateRuntimeKey } from "./runtime-key.ts";

export type AwsCoreEvidence = {
  readonly verified: true;
  readonly stackId: string;
  readonly stackName: string;
  readonly accountId: string;
  readonly region: string;
  readonly phase: string;
  readonly identityVerificationStatus: string;
  readonly verifiedForSending: boolean;
  readonly dkimStatus: string;
  readonly dkimSigningEnabled: boolean;
  readonly runtimeAccessKeyId: unknown;
  readonly productionAccessStatus: unknown;
};

export function runAwsCoreVerification(
  env: PathEnvironment = process.env,
  initialState?: SetupState,
): Effect.Effect<AwsCoreEvidence, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId =
      initialState?.installationId ?? (yield* store.resolveInstallationId(env));
    let state = yield* store.loadState(installationId, env);
    const caller = yield* resolveCallerContext(state, env);

    const stack = state.aws?.stack;
    if (stack == null || typeof stack !== "object") {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "AWS core is blocked: no stack ownership is stored. Run `pnpm nusend:setup aws plan` then `aws apply`.",
        }),
      );
    }
    const stackName = String(stack.stackName ?? "");
    const stackId = String(stack.stackId ?? "");
    const accountId = String(stack.accountId ?? "");
    const region = String(stack.region ?? "");
    if (!stackName || !stackId || !accountId || !region) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "AWS core is blocked: stored stack ownership is incomplete.",
        }),
      );
    }
    if (accountId !== state.config.awsAccountId || accountId !== caller.accountId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS core is blocked: stack account ${accountId} does not match expected/caller account.`,
        }),
      );
    }
    if (region !== state.config.awsRegion) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS core is blocked: stack region ${region} does not match configured ${state.config.awsRegion}.`,
        }),
      );
    }
    if (stackName !== buildStackName(state.installationId)) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS core is blocked: unexpected stack name ${stackName}.`,
        }),
      );
    }

    const live = yield* describeStack(state, stackName, env);
    if (!live.exists || live.stackId !== stackId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS core is blocked: live stack id does not match stored ownership (${stackId}).`,
        }),
      );
    }
    if (!live.status || !/_COMPLETE$/u.test(live.status) || /ROLLBACK|FAILED/u.test(live.status)) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS core is blocked: live stack status is ${live.status ?? "unknown"}.`,
        }),
      );
    }

    const identity = yield* refreshAndStoreIdentity(state, env, { persist: true });
    state = yield* store.loadState(installationId, env);
    if (
      !isIdentityReady({
        VerificationStatus: identity.verificationStatus,
        VerifiedForSendingStatus: identity.verifiedForSending,
      })
    ) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS core is blocked: SES identity verification is not ready (VerificationStatus=${identity.verificationStatus}, VerifiedForSending=${identity.verifiedForSending}). Publish DKIM/DNS and rerun continue.`,
        }),
      );
    }
    if (
      !isDkimReady({
        DkimAttributes: {
          Status: identity.dkimStatus,
          SigningEnabled: identity.dkimSigningEnabled,
        },
      })
    ) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS core is blocked: DKIM is not ready (Status=${identity.dkimStatus}, SigningEnabled=${identity.dkimSigningEnabled}). Wait for DNS propagation and rerun continue.`,
        }),
      );
    }

    const deployment = yield* store.loadDeploymentEnv(installationId, env);
    const envKeyId = deployment.AWS_ACCESS_KEY_ID
      ? unwrapEnvValue(deployment.AWS_ACCESS_KEY_ID).trim()
      : "";
    const envSecret = deployment.AWS_SECRET_ACCESS_KEY
      ? unwrapEnvValue(deployment.AWS_SECRET_ACCESS_KEY).trim()
      : "";
    if (!state.aws?.runtimeAccessKeyId) {
      yield* writeLine(
        "Runtime access key is missing; creating one requires an exact confirmation phrase.",
      );
      yield* runCreateRuntimeKey(env, { existingState: state });
      state = yield* store.loadState(installationId, env);
    } else if (!envKeyId || !envSecret) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS core is blocked: runtime key ${state.aws.runtimeAccessKeyId} is recorded but deployment.env is missing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. Restore the secret manually; the coordinator will not recreate it automatically.`,
        }),
      );
    } else if (state.aws.runtimeAccessKeyId !== envKeyId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "AWS core is blocked: deployment.env AWS_ACCESS_KEY_ID does not match the recorded runtime key id.",
        }),
      );
    }

    yield* refreshProductionAccessStatus(state, env, { persist: true });
    state = yield* store.loadState(installationId, env);
    const production = (state.aws?.productionAccess ?? {}) as Record<string, unknown>;
    if (
      production.productionAccessEnabled !== true &&
      production.status !== "pending" &&
      production.reviewStatus !== "PENDING"
    ) {
      yield* writeLine(
        "SES production access is not approved yet (sandbox ok for simulator). Submission remains optional via guided prompts.",
      );
      const submit = yield* askBoolean("Submit SES production-access request now?", false);
      if (submit) {
        yield* runProductionAccessRequest(env, {
          existingState: state,
          submitEnabled: true,
        });
        state = yield* store.loadState(installationId, env);
      }
    }

    const finalDeployment = yield* store.loadDeploymentEnv(installationId, env);
    const requiredEnv = [
      "AWS_REGION",
      "NUSEND_SES_FROM_EMAIL",
      "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET",
      "NUSEND_SES_FEEDBACK_TOPIC_ARNS",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ];
    for (const key of requiredEnv) {
      const raw = finalDeployment[key];
      if (!raw || unwrapEnvValue(raw).trim() === "") {
        return yield* Effect.fail(
          new SetupCommandError({
            message: `AWS core is blocked: deployment.env missing ${key}.`,
          }),
        );
      }
    }
    const marketingSet = finalDeployment.NUSEND_SES_MARKETING_CONFIGURATION_SET;
    if (
      state.config.marketingEnabled &&
      (!marketingSet || unwrapEnvValue(marketingSet).trim() === "")
    ) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "AWS core is blocked: marketing configuration set missing from deployment.env.",
        }),
      );
    }

    return {
      verified: true as const,
      stackId,
      stackName,
      accountId,
      region,
      phase: String(stack.phase ?? "core"),
      identityVerificationStatus: identity.verificationStatus,
      verifiedForSending: identity.verifiedForSending,
      dkimStatus: identity.dkimStatus,
      dkimSigningEnabled: identity.dkimSigningEnabled,
      runtimeAccessKeyId: state.aws?.runtimeAccessKeyId,
      productionAccessStatus:
        (state.aws?.productionAccess as { status?: unknown } | undefined)?.status ?? "unknown",
    };
  });
}

export function awsCoreStageHandler(env: PathEnvironment = process.env): StageHandler {
  return {
    isEligible: (state) => Effect.succeed(state.stages.init?.status === "complete"),
    run: (state) =>
      runAwsCoreVerification(env, state).pipe(
        Effect.map((evidence) => evidence as unknown as Record<string, unknown>),
      ),
  };
}
