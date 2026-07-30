import { Clock, Effect } from "effect";

import { ask, writeLine } from "../commands/prompts.ts";
import { SetupCommandError } from "../errors.ts";
import { SetupStore } from "../services/setup-store.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import {
  APPLY_CHECKPOINT_LOCAL_FINALIZATION,
  AWS_PLAN_KEY,
  defaultStackTemplatePath,
} from "./constants.ts";
import { refreshAndStoreIdentity } from "./identity.ts";
import {
  asCommandError,
  collectStackFailureDiagnostics,
  describeChangeSet,
  describeStack,
  executeChangeSet,
  loadStackTemplate,
  makeStateRunner,
  resolveCallerContext,
  stackCreationProofForApply,
  waitStackComplete,
  type AwsWorkflowError,
  type AwsWorkflowServices,
  type WorkflowCaller,
} from "./ops.ts";
import {
  buildApplyConfirmationPhrase,
  buildStackName,
  buildStackParameters,
  determinePhase,
  expectedStackIdFromPlan,
  fingerprintTemplateAndParameters,
  formatDkimRecords,
  isHealthyTerminalStackStatus,
  isLocalFinalizationCheckpoint,
  isNoChangeChangeSet,
  mapStackOutputsToEnv,
  parseChangeSetArn,
  parseStackOutputs,
  summarizeChangeSet,
  validateApplyConfirmation,
} from "./pure.ts";
import {
  assertPreFinalizeSubscriptionAbsence,
  verifyFinalizedSubscription,
} from "./subscription.ts";

export type AwsApplyResult = {
  readonly state: SetupState;
  readonly outputs: Record<string, string>;
  readonly noChange: boolean;
};

export type AwsApplyOptions = {
  readonly templatePath?: string;
  /** Test seam: runs after provider checkpoint, before env write. */
  readonly afterProviderCheckpoint?: (input: {
    readonly state: SetupState;
  }) => Effect.Effect<void, SetupCommandError>;
  readonly confirmation?: string;
};

export function runAwsApply(
  env: PathEnvironment = process.env,
  options: AwsApplyOptions = {},
): Effect.Effect<AwsApplyResult, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);
    const caller = yield* resolveCallerContext(state, env);
    const plan = state.plans?.[AWS_PLAN_KEY] as Record<string, unknown> | undefined;
    if (plan == null || typeof plan !== "object") {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "No stored AWS plan. Run `pnpm nusend:setup aws plan` first.",
        }),
      );
    }

    if (plan.consumed === true) {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "Stored AWS plan is already consumed. Re-run `pnpm nusend:setup aws plan` before applying again.",
        }),
      );
    }

    const stackName = String(plan.stackName ?? "");
    const phase = String(plan.phase ?? "") as "core" | "finalize";
    const region = String(plan.region ?? "");
    const accountId = String(plan.accountId ?? "");
    const fingerprint = String(plan.fingerprint ?? "");
    const changeSetArn = String(plan.changeSetArn ?? "");
    const noChange = plan.noChange === true;
    const partition = String(plan.partition ?? caller.partition);
    const resumeLocalFinalization = isLocalFinalizationCheckpoint(plan);

    if (
      !stackName ||
      (phase !== "core" && phase !== "finalize") ||
      !region ||
      !accountId ||
      !fingerprint
    ) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "Stored AWS plan is incomplete. Re-run `pnpm nusend:setup aws plan`.",
        }),
      );
    }
    if (accountId !== state.config.awsAccountId || accountId !== caller.accountId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Stored plan account ${accountId} does not match expected ${state.config.awsAccountId} / caller ${caller.accountId}.`,
        }),
      );
    }
    if (region !== state.config.awsRegion || region !== caller.region) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Stored plan region ${region} does not match configured ${state.config.awsRegion}.`,
        }),
      );
    }
    if (stackName !== buildStackName(state.installationId)) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Stored plan stack ${stackName} does not match derived stack name.`,
        }),
      );
    }
    const expectedPhase = determinePhase(state);
    if (phase !== expectedPhase) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Stored plan phase "${phase}" does not match current phase "${expectedPhase}". Re-run \`pnpm nusend:setup aws plan\`.`,
        }),
      );
    }

    const templatePath = options.templatePath ?? defaultStackTemplatePath();
    const template = yield* loadStackTemplate(templatePath);
    const parameters = buildStackParameters(state, phase);
    const currentFingerprint = fingerprintTemplateAndParameters(template.body, parameters, {
      stackName,
      phase,
    });
    if (currentFingerprint !== fingerprint) {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "Stored AWS plan fingerprint does not match current template/parameters. Re-run `pnpm nusend:setup aws plan`.",
        }),
      );
    }

    if (!resumeLocalFinalization) {
      const expectedPhrase = buildApplyConfirmationPhrase({
        accountId,
        region,
        stackName,
        phase,
      });
      yield* writeLine(`About to apply AWS change set for ${stackName} (${phase}).`);
      yield* writeLine(`Type exactly: ${expectedPhrase}`);
      const answer = options.confirmation ?? (yield* ask("Confirmation: "));
      try {
        validateApplyConfirmation(answer, { accountId, region, stackName, phase });
      } catch (error) {
        return yield* Effect.fail(asCommandError(error));
      }

      if (noChange) {
        yield* assertNoChangeStackReady(state, plan, stackName, env);
      } else {
        if (!changeSetArn.startsWith("arn:")) {
          return yield* Effect.fail(
            new SetupCommandError({
              message: "Stored plan is missing a change set ARN.",
            }),
          );
        }
        yield* executeOrResumeChangeSet(state, plan, caller, stackName, changeSetArn, env);
      }
    } else {
      yield* writeLine(
        `Resuming local finalization for ${stackName} (${phase}) after provider-side apply success; skipping provider mutation.`,
      );
    }

    const stackInfo = yield* describeStack(state, stackName, env);
    if (!stackInfo.exists || !stackInfo.raw || !stackInfo.stackId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Stack ${stackName} was not found after apply.`,
        }),
      );
    }
    const status = String(stackInfo.status ?? "");
    if (!isHealthyTerminalStackStatus(status)) {
      const diagnostics = yield* collectStackFailureDiagnostics(state, stackName, env);
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Stack ${stackName} ended in status ${status}.\n${diagnostics}`,
        }),
      );
    }

    const expectedStackId = expectedStackIdFromPlan(plan, state);
    if (expectedStackId && stackInfo.stackId !== expectedStackId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Live stack id ${stackInfo.stackId} does not match expected ${expectedStackId}. Refusing to adopt a same-name replacement.`,
        }),
      );
    }
    const boundStackId = expectedStackId ?? stackInfo.stackId;

    const outputs = parseStackOutputs(stackInfo.raw.Outputs ?? []);
    const envPatch = mapStackOutputsToEnv(outputs, state);
    let finalizedSubscription: Record<string, unknown> | undefined;
    if (phase === "finalize") {
      const run = yield* makeStateRunner(state);
      const evidence = yield* verifyFinalizedSubscription(
        {
          ...state,
          aws: {
            ...(state.aws ?? {}),
            stack: {
              ...(state.aws?.stack ?? {}),
              stackId: boundStackId,
              stackName,
              accountId,
              partition,
              region,
              phase,
              status,
              outputs,
            },
          },
        },
        run,
      );
      finalizedSubscription = evidence as unknown as Record<string, unknown>;
    }

    const nowMillis = yield* Clock.currentTimeMillis;
    const providerAppliedAt =
      typeof plan.providerAppliedAt === "string" && plan.providerAppliedAt
        ? plan.providerAppliedAt
        : new Date(nowMillis).toISOString();

    const stackCreation = yield* stackCreationProofForApply(state, plan, {
      stackId: boundStackId,
      stackName,
      accountId,
      partition,
      region,
      fingerprint,
      appliedAt: providerAppliedAt,
    });

    const checkpointState: SetupState = {
      ...state,
      updatedAt: providerAppliedAt,
      plans: {
        ...state.plans,
        [AWS_PLAN_KEY]: sanitizePlanMetadata({
          ...plan,
          stackId: boundStackId,
          providerApplied: true,
          applyCheckpoint: APPLY_CHECKPOINT_LOCAL_FINALIZATION,
          providerAppliedAt,
          consumed: false,
        }),
      },
      aws: sanitizePlanMetadata({
        ...(state.aws ?? {}),
        ...(stackCreation ? { stackCreation } : {}),
        stack: {
          stackId: boundStackId,
          stackName,
          accountId,
          partition,
          region,
          phase,
          status,
          outputs,
          appliedFingerprint: fingerprint,
          appliedAt: providerAppliedAt,
          changeSetType: String(plan.changeSetType ?? ""),
          ...(finalizedSubscription ? { subscription: finalizedSubscription } : {}),
        },
      }) as SetupState["aws"],
    };
    yield* store.writeState(checkpointState, env);

    if (options.afterProviderCheckpoint) {
      yield* options.afterProviderCheckpoint({ state: checkpointState });
    }

    const deployment = yield* store.loadDeploymentEnv(installationId, env);
    const nextEnv = { ...deployment, ...envPatch };
    yield* store.writeDeploymentEnv(installationId, nextEnv, env);

    const dkimRecords = formatDkimRecords(outputs);
    yield* writeLine("Stack outputs mapped into deployment.env (non-secret values only).");
    if (dkimRecords.length > 0) {
      yield* writeLine(
        "DKIM CNAME records (publish at your DNS provider if Route 53 is not managing them):",
      );
      for (const record of dkimRecords) {
        yield* writeLine(`  CNAME ${record.name} -> ${record.value}`);
      }
    }

    const identity = yield* refreshAndStoreIdentity(checkpointState, env, { persist: false });

    const appliedMillis = yield* Clock.currentTimeMillis;
    const appliedAt = new Date(appliedMillis).toISOString();
    const nextState: SetupState = {
      ...checkpointState,
      updatedAt: appliedAt,
      plans: {
        ...checkpointState.plans,
        [AWS_PLAN_KEY]: sanitizePlanMetadata({
          consumed: true,
          consumedAt: appliedAt,
          previousChangeSetArn: changeSetArn || null,
          phase,
          stackName,
          stackId: boundStackId,
          fingerprint,
          accountId,
          partition,
          region,
          noChange,
          providerAppliedAt,
        }),
      },
      aws: sanitizePlanMetadata({
        ...(checkpointState.aws ?? {}),
        ...(stackCreation ? { stackCreation } : {}),
        stack: {
          stackId: boundStackId,
          stackName,
          accountId,
          partition,
          region,
          phase,
          status,
          outputs,
          appliedFingerprint: fingerprint,
          appliedAt,
          changeSetType: String(plan.changeSetType ?? ""),
          ...(finalizedSubscription ? { subscription: finalizedSubscription } : {}),
        },
        identity: {
          ...identity,
          checkedAt: appliedAt,
        },
      }) as SetupState["aws"],
    };
    yield* store.writeState(nextState, env);
    yield* writeLine(
      `AWS apply complete for ${stackName} (${phase}). continue remains blocked until identity/DKIM success and the runtime key exist.`,
    );
    return { state: nextState, outputs, noChange };
  });
}

function assertNoChangeStackReady(
  state: SetupState,
  plan: Record<string, unknown>,
  stackName: string,
  env: PathEnvironment,
): Effect.Effect<void, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    yield* writeLine("Plan recorded NO_CHANGES; skipping change-set execution.");
    const stackInfo = yield* describeStack(state, stackName, env);
    if (!stackInfo.exists || !stackInfo.stackId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `NO_CHANGES plan requires existing stack ${stackName} with a stable stack id.`,
        }),
      );
    }
    if (!isHealthyTerminalStackStatus(stackInfo.status)) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `NO_CHANGES apply refused: stack ${stackName} status is ${stackInfo.status ?? "unknown"}.`,
        }),
      );
    }
    const expectedStackId = expectedStackIdFromPlan(plan, state);
    if (expectedStackId && stackInfo.stackId !== expectedStackId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `NO_CHANGES apply refused: live stack id ${stackInfo.stackId} does not match stored ${expectedStackId}.`,
        }),
      );
    }
    const changeSetArn = String(plan.changeSetArn ?? "");
    if (changeSetArn.startsWith("arn:")) {
      const described = yield* describeChangeSet(state, changeSetArn, env);
      if (!isNoChangeChangeSet(described)) {
        const summary = summarizeChangeSet(described);
        return yield* Effect.fail(
          new SetupCommandError({
            message: `Stored plan is marked NO_CHANGES but live change set status=${summary.status} reason=${summary.statusReason || "none"}. Re-run plan.`,
          }),
        );
      }
      const summary = summarizeChangeSet(described);
      if (summary.stackName && summary.stackName !== stackName) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: `NO_CHANGES change set stack name ${summary.stackName} does not match ${stackName}.`,
          }),
        );
      }
      if (expectedStackId && summary.stackId && summary.stackId !== expectedStackId) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: `NO_CHANGES change set stack id ${summary.stackId} does not match stored ${expectedStackId}.`,
          }),
        );
      }
    }
  });
}

function validateLiveChangeSet(
  state: SetupState,
  plan: Record<string, unknown>,
  caller: WorkflowCaller,
  stackName: string,
  changeSetArn: string,
  env: PathEnvironment,
): Effect.Effect<
  {
    summary: ReturnType<typeof summarizeChangeSet>;
    expectedStackId: string | null;
  },
  AwsWorkflowError,
  AwsWorkflowServices
> {
  return Effect.gen(function* () {
    let arnParts;
    try {
      arnParts = parseChangeSetArn(changeSetArn);
    } catch (error) {
      return yield* Effect.fail(asCommandError(error));
    }
    const planAccountId = String(plan.accountId ?? "");
    const planRegion = String(plan.region ?? "");
    const planPartition = String(plan.partition ?? caller.partition);
    if (arnParts.accountId !== planAccountId || arnParts.accountId !== caller.accountId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Change set ARN account ${arnParts.accountId} does not match plan ${planAccountId} / caller ${caller.accountId}.`,
        }),
      );
    }
    if (arnParts.region !== planRegion || arnParts.region !== caller.region) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Change set ARN region ${arnParts.region} does not match plan ${planRegion} / caller ${caller.region}.`,
        }),
      );
    }
    if (arnParts.partition !== planPartition) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Change set ARN partition ${arnParts.partition} does not match expected ${planPartition}.`,
        }),
      );
    }

    const described = yield* describeChangeSet(state, changeSetArn, env);
    const summary = summarizeChangeSet(described);
    const liveId = String(described.ChangeSetId ?? summary.changeSetId ?? "");
    if (liveId && liveId !== changeSetArn) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Live change set id ${liveId} does not match stored ARN ${changeSetArn}. Re-run plan.`,
        }),
      );
    }
    if (summary.stackName && summary.stackName !== stackName) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Change set stack name ${summary.stackName} does not match stored plan stack ${stackName}.`,
        }),
      );
    }
    const expectedStackId = expectedStackIdFromPlan(plan, state);
    if (expectedStackId && summary.stackId && summary.stackId !== expectedStackId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Change set stack id ${summary.stackId} does not match stored stack id ${expectedStackId}. Refusing to adopt a same-name replacement.`,
        }),
      );
    }
    return { summary, expectedStackId };
  });
}

function executeOrResumeChangeSet(
  state: SetupState,
  plan: Record<string, unknown>,
  caller: WorkflowCaller,
  stackName: string,
  changeSetArn: string,
  env: PathEnvironment,
): Effect.Effect<void, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const { summary, expectedStackId } = yield* validateLiveChangeSet(
      state,
      plan,
      caller,
      stackName,
      changeSetArn,
      env,
    );
    const executionStatus = summary.executionStatus;

    if (executionStatus === "OBSOLETE" || executionStatus === "UNAVAILABLE") {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Stored change set is ${executionStatus}. Re-run \`pnpm nusend:setup aws plan\` and review a fresh change set.`,
        }),
      );
    }

    if (executionStatus === "AVAILABLE") {
      if (summary.status !== "CREATE_COMPLETE") {
        return yield* Effect.fail(
          new SetupCommandError({
            message: `Change set status ${summary.status || "unknown"} is not executable (execution=${executionStatus}). Re-run plan.`,
          }),
        );
      }
      if (plan.phase === "finalize") {
        const run = yield* makeStateRunner(state);
        yield* assertPreFinalizeSubscriptionAbsence(state, run, env);
      }
      const executed = yield* executeChangeSet(state, changeSetArn, env);
      if (executed.exitCode !== 0) {
        const redecribed = yield* describeChangeSet(state, changeSetArn, env);
        const liveExecution = summarizeChangeSet(redecribed).executionStatus;
        if (liveExecution !== "EXECUTE_IN_PROGRESS" && liveExecution !== "EXECUTE_COMPLETE") {
          return yield* Effect.fail(
            new SetupCommandError({
              message: `execute-change-set failed for ${changeSetArn} (execution=${liveExecution || "unknown"}):\n${executed.stderr || executed.stdout}`,
            }),
          );
        }
        yield* writeLine(
          `execute-change-set returned an error, but change set execution is ${liveExecution}; continuing without re-executing.`,
        );
      }
    } else if (executionStatus === "EXECUTE_IN_PROGRESS") {
      yield* writeLine(
        "Change set execution already in progress; waiting for the stack operation to finish.",
      );
    } else if (executionStatus === "EXECUTE_COMPLETE") {
      yield* writeLine("Change set already executed; resuming post-provider local finalization.");
    } else {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Unexpected change set execution status "${executionStatus || "empty"}". Re-run \`pnpm nusend:setup aws plan\`.`,
        }),
      );
    }

    const waited = yield* waitStackComplete(
      state,
      stackName,
      String(plan.changeSetType ?? "CREATE"),
      env,
    );
    if (waited.exitCode !== 0) {
      const stackInfo = yield* describeStack(state, stackName, env);
      if (
        !stackInfo.exists ||
        !isHealthyTerminalStackStatus(stackInfo.status) ||
        (expectedStackId && stackInfo.stackId !== expectedStackId)
      ) {
        const diagnostics = yield* collectStackFailureDiagnostics(state, stackName, env);
        return yield* Effect.fail(
          new SetupCommandError({
            message: `Stack operation failed for ${stackName}.\n${diagnostics}`,
          }),
        );
      }
      yield* writeLine(
        `Stack waiter exited non-zero, but live stack ${stackName} is ${stackInfo.status}; continuing local finalization.`,
      );
    }
  });
}
