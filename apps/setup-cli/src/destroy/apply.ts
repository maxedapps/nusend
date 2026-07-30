import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";

import { describeStack, liftProviderError, makeStateRunner } from "../aws/ops.ts";
import { isActiveStackStatus } from "../aws/pure.ts";
import { decodeAwsJson } from "../aws/schemas.ts";
import { ask, writeLine } from "../commands/prompts.ts";
import { inspectExistingCheckout, posixSingleQuote, runSsh } from "../deploy/index.ts";
import { SetupCommandError } from "../errors.ts";
import { SetupStore } from "../services/setup-store.ts";
import { plainDeploymentEnv } from "../state/env.ts";
import type { PathEnvironment } from "../state/paths.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { SetupState } from "../state/schema.ts";
import { readDlqCounters } from "../validate/ops.ts";
import { assertDlqEmpty } from "../validate/pure.ts";
import {
  inventoryAlarms,
  inventorySubscriptions,
  listRuntimeKeys,
  listStackResources,
} from "./inventory.ts";
import { assertCallerBinding, failDestroy, reportRetained } from "./plan.ts";
import type { DestroyWorkflowError, DestroyWorkflowServices } from "./plan.ts";
import {
  assertInitialStackCreationProof,
  assertRuntimeKeyInventory,
  buildDestroyConfirmationPhrase,
  DESTROY_PLAN_KEY,
  DESTROY_PLAN_VERSION,
  exactProviderInventoryMatches,
  fingerprintDestroyPlan,
  isExactKeyDeleteIntent,
  isExactStackDeleteIntent,
  isSshUnreachable,
  RETAINED_RESOURCES,
  reviewedRemoteEvidence,
  stackLastUpdatedTime,
  validateDestroyConfirmation,
  type StackCreationBinding,
} from "./pure.ts";

const StackEventsSchema = Schema.Struct({
  StackEvents: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});

function persistApply(
  state: SetupState,
  plan: Record<string, unknown>,
  apply: Record<string, unknown>,
  env: PathEnvironment,
): Effect.Effect<SetupState, DestroyWorkflowError, DestroyWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    const latest = yield* store.loadState(state.installationId, env);
    const currentPlan = latest.plans?.[DESTROY_PLAN_KEY];
    if (!currentPlan || currentPlan.fingerprint !== plan.fingerprint) {
      return yield* failDestroy("Destroy plan changed while applying; refusing to continue.");
    }
    yield* store.writeState(
      {
        ...latest,
        updatedAt: now,
        plans: {
          ...latest.plans,
          [DESTROY_PLAN_KEY]: sanitizePlanMetadata({
            ...currentPlan,
            apply,
            updatedAt: now,
          }),
        },
      },
      env,
    );
    return yield* store.loadState(state.installationId, env);
  });
}

function stopRemoteCompose(
  state: SetupState,
  evidence: { remotePath: string },
): Effect.Effect<Record<string, unknown>, never, DestroyWorkflowServices> {
  return Effect.gen(function* () {
    const resultExit = yield* Effect.exit(
      runSsh(state, `cd ${posixSingleQuote(evidence.remotePath)} && docker compose stop`, {
        allowNonZero: true,
      }),
    );
    if (Exit.isFailure(resultExit)) {
      const typed = Cause.findErrorOption(resultExit.cause);
      const detail = Option.isSome(typed)
        ? String((typed.value as { message?: string }).message ?? typed.value)
        : Cause.pretty(resultExit.cause);
      if (!isSshUnreachable(new Error(detail))) {
        return {
          reachable: true,
          stopped: false,
          fatal: true,
          detail,
          command: "docker compose stop",
          volumesRemoved: false,
        };
      }
      return {
        reachable: false,
        stopped: false,
        skipped: true,
        reason: "unreachable",
        command: "docker compose stop",
        volumesRemoved: false,
        detail,
      };
    }
    const result = resultExit.value;
    return {
      reachable: true,
      stopped: result.exitCode === 0,
      exitCode: result.exitCode,
      command: "docker compose stop",
      volumesRemoved: false,
    };
  });
}

function recheckReviewedRemote(
  state: SetupState,
  plan: Record<string, unknown>,
): Effect.Effect<
  | { trusted: true; evidence: Record<string, string>; checkout: unknown }
  | { trusted: false; outcome: Record<string, unknown> },
  never,
  DestroyWorkflowServices
> {
  return Effect.gen(function* () {
    const remote =
      plan.remote && typeof plan.remote === "object"
        ? (plan.remote as Record<string, unknown>)
        : {};
    const evidence = reviewedRemoteEvidence(remote, state);
    if (!evidence) {
      return {
        trusted: false as const,
        outcome: {
          reachable: null,
          stopped: false,
          skipped: true,
          reason: "identity-not-reviewed-or-state-changed",
          command: "docker compose stop",
          volumesRemoved: false,
        },
      };
    }
    const checkoutExit = yield* Effect.exit(
      inspectExistingCheckout(state, evidence.remotePath, evidence.releaseTag, evidence.commitSha),
    );
    if (Exit.isFailure(checkoutExit)) {
      const typed = Cause.findErrorOption(checkoutExit.cause);
      const detail = Option.isSome(typed)
        ? String((typed.value as { message?: string }).message ?? typed.value)
        : Cause.pretty(checkoutExit.cause);
      return {
        trusted: false as const,
        outcome: {
          reachable: !isSshUnreachable(new Error(detail)),
          stopped: false,
          skipped: true,
          reason: isSshUnreachable(new Error(detail)) ? "unreachable" : "identity-unproven",
          command: "docker compose stop",
          volumesRemoved: false,
          detail,
        },
      };
    }
    return {
      trusted: true as const,
      evidence: evidence as unknown as Record<string, string>,
      checkout: checkoutExit.value,
    };
  });
}

function deletionFailureDiagnostics(
  state: SetupState,
  stackId: string,
  env: PathEnvironment,
): Effect.Effect<string, never, DestroyWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const resultExit = yield* Effect.exit(
      run(
        [
          "cloudformation",
          "describe-stack-events",
          "--stack-name",
          stackId,
          "--max-items",
          "30",
          "--output",
          "json",
        ],
        { allowNonZero: true },
      ).pipe(
        Effect.catch((error) =>
          liftProviderError(state, env, "cloudformation describe-stack-events", error),
        ),
      ),
    );
    if (Exit.isFailure(resultExit)) {
      return "CloudFormation deletion diagnostics unavailable.";
    }
    const result = resultExit.value;
    if (result.exitCode !== 0) return "CloudFormation deletion diagnostics unavailable.";
    const payloadExit = yield* Effect.exit(
      decodeAwsJson(StackEventsSchema, result.stdout, "cloudformation describe-stack-events"),
    );
    if (Exit.isFailure(payloadExit)) {
      return "CloudFormation deletion diagnostics unavailable.";
    }
    const events = Array.isArray(payloadExit.value.StackEvents)
      ? payloadExit.value.StackEvents
      : [];
    const failures = events
      .filter((event) => String(event?.ResourceStatus ?? "") === "DELETE_FAILED")
      .slice(0, 10)
      .map(
        (event) =>
          `${String(event?.LogicalResourceId ?? "unknown")}: ${String(event?.ResourceStatusReason ?? "no reason returned")}`,
      );
    return failures.length > 0
      ? `Failed logical resource(s):\n${failures.map((line) => `- ${line}`).join("\n")}`
      : "No DELETE_FAILED logical-resource event was returned; inspect this exact stack ID.";
  });
}

export function runDestroyApply(
  env: PathEnvironment = process.env,
): Effect.Effect<
  { verified: true; stackId: string; retainedResources: string[] },
  DestroyWorkflowError,
  DestroyWorkflowServices
> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    let state = yield* store.loadState(installationId, env);
    const planRaw = state.plans?.[DESTROY_PLAN_KEY];
    if (!planRaw || typeof planRaw !== "object") {
      return yield* failDestroy(
        "No reviewed destroy plan. Run `pnpm nusend:setup destroy plan` first.",
      );
    }
    const plan = planRaw as Record<string, unknown>;
    if (plan.consumed === true) {
      return yield* failDestroy("Destroy plan is already consumed; stack deletion was verified.");
    }
    if (
      plan.version !== DESTROY_PLAN_VERSION ||
      fingerprintDestroyPlan(plan) !== plan.fingerprint
    ) {
      return yield* failDestroy(
        "Stored destroy plan fingerprint is stale or mismatched. Run destroy plan again.",
      );
    }

    let binding: StackCreationBinding;
    try {
      binding = assertInitialStackCreationProof(state);
    } catch (error) {
      return yield* failDestroy(error instanceof Error ? error.message : String(error));
    }
    yield* assertCallerBinding(state, binding, env);

    for (const [key, expected] of Object.entries({
      installationId,
      accountId: binding.accountId,
      partition: binding.partition,
      region: binding.region,
      stackId: binding.stackId,
      stackName: binding.stackName,
      domain: state.config.domain,
      sshTarget: state.config.sshTarget,
      remotePath: state.config.remotePath,
      creationProofFingerprint: String(binding.proof.fingerprint),
      creationChangeSetArn: String(binding.proof.changeSetArn),
    })) {
      if (plan[key] !== expected) {
        return yield* failDestroy(`Stored destroy plan ${key} differs from current exact state.`);
      }
    }

    let apply: Record<string, unknown> =
      plan.apply && typeof plan.apply === "object"
        ? { ...(plan.apply as Record<string, unknown>) }
        : {};
    const outputs = state.aws?.stack?.outputs as Record<string, unknown> | undefined;
    const runtimeUserName = String(outputs?.RuntimeUserName ?? "");
    const runtimeAccessKeyId = String(
      (state.aws as { runtimeAccessKeyId?: unknown } | undefined)?.runtimeAccessKeyId ?? "",
    );
    if (
      runtimeUserName !== plan.runtimeUserName ||
      runtimeAccessKeyId !== plan.runtimeAccessKeyId
    ) {
      return yield* failDestroy("Runtime key/user state differs from the reviewed destroy plan.");
    }

    let live = yield* describeStack(state, binding.stackId, env);
    if (live.exists && live.stackId !== binding.stackId) {
      return yield* failDestroy("Live stack differs from the exact reviewed stack ID.");
    }
    const resumingOwnDeletion =
      live.status === "DELETE_IN_PROGRESS" &&
      isExactStackDeleteIntent(
        apply.stackDeleteIntent as Record<string, unknown> | undefined,
        binding,
      );
    if (live.exists && isActiveStackStatus(live.status) && !resumingOwnDeletion) {
      return yield* failDestroy(`Destroy is blocked: stack operation is active (${live.status}).`);
    }
    if (
      !live.exists &&
      !isExactStackDeleteIntent(
        apply.stackDeleteIntent as Record<string, unknown> | undefined,
        binding,
      )
    ) {
      return yield* failDestroy(
        "Exact stack is unexplainedly missing; no matching deletion-request checkpoint exists.",
      );
    }

    const run = yield* makeStateRunner(state);
    const keyInventory = yield* listRuntimeKeys(run, runtimeUserName).pipe(
      Effect.catch((error) =>
        error instanceof SetupCommandError
          ? Effect.fail(error)
          : liftProviderError(state, env, "iam list-access-keys", error as never),
      ),
    );
    try {
      assertRuntimeKeyInventory(
        keyInventory,
        runtimeAccessKeyId,
        isExactKeyDeleteIntent(
          apply.runtimeKeyDeleteIntent as Record<string, unknown> | undefined,
          runtimeAccessKeyId,
          runtimeUserName,
          binding,
        ),
      );
    } catch (error) {
      return yield* failDestroy(error instanceof Error ? error.message : String(error));
    }
    if (live.exists) {
      const dlq = yield* readDlqCounters(state, run).pipe(
        Effect.catch((error) =>
          error instanceof SetupCommandError
            ? Effect.fail(error)
            : liftProviderError(state, env, "sqs get-queue-attributes", error as never),
        ),
      );
      try {
        assertDlqEmpty(dlq);
      } catch (error) {
        return yield* failDestroy(error instanceof Error ? error.message : String(error));
      }
    }

    if (
      live.exists &&
      !isExactStackDeleteIntent(
        apply.stackDeleteIntent as Record<string, unknown> | undefined,
        binding,
      )
    ) {
      const refreshedResources = yield* listStackResources(run, binding.stackId).pipe(
        Effect.catch((error) =>
          error instanceof SetupCommandError
            ? Effect.fail(error)
            : liftProviderError(state, env, "list-stack-resources", error as never),
        ),
      );
      const feedbackTopicArn = String(outputs?.FeedbackTopicArn ?? "");
      const alarmTopicArn = String(outputs?.AlarmTopicArn ?? "");
      const refreshedSubscriptions = {
        feedback: yield* inventorySubscriptions(run, feedbackTopicArn).pipe(
          Effect.catch((error) =>
            error instanceof SetupCommandError
              ? Effect.fail(error)
              : liftProviderError(state, env, "sns", error as never),
          ),
        ),
        alarm: yield* inventorySubscriptions(run, alarmTopicArn).pipe(
          Effect.catch((error) =>
            error instanceof SetupCommandError
              ? Effect.fail(error)
              : liftProviderError(state, env, "sns", error as never),
          ),
        ),
      };
      const refreshedAlarms = yield* inventoryAlarms(state, run).pipe(
        Effect.catch((error) =>
          error instanceof SetupCommandError
            ? Effect.fail(error)
            : liftProviderError(state, env, "cloudwatch", error as never),
        ),
      );
      const changed: string[] = [];
      const plannedLastUpdated =
        plan.stackLastUpdatedTime == null ? null : String(plan.stackLastUpdatedTime);
      if (stackLastUpdatedTime(live.raw) !== plannedLastUpdated) {
        changed.push("CloudFormation LastUpdatedTime");
      }
      if (!exactProviderInventoryMatches(plan.stackResources, refreshedResources.resources)) {
        changed.push("exact stack resources");
      }
      if (!exactProviderInventoryMatches(plan.subscriptions, refreshedSubscriptions)) {
        changed.push("feedback/alarm subscriptions");
      }
      if (!exactProviderInventoryMatches(plan.alarms, refreshedAlarms)) {
        changed.push("alarms");
      }
      if (changed.length > 0) {
        return yield* failDestroy(
          `Destroy plan provider inventory changed after planning (${changed.join(", ")}); run destroy plan again.`,
        );
      }
    }

    if (!apply.approved) {
      yield* reportRetained(
        Array.isArray(plan.externalDkimRecords)
          ? (plan.externalDkimRecords as Array<{ name: string; value: string }>)
          : [],
      );
      const expected = buildDestroyConfirmationPhrase(plan as never);
      yield* writeLine(`Type exactly: ${expected}`);
      const answer = yield* ask("Destroy confirmation: ", true);
      try {
        validateDestroyConfirmation(answer, plan as never);
      } catch (error) {
        return yield* failDestroy(error instanceof Error ? error.message : String(error));
      }
      const nowMillis = yield* Clock.currentTimeMillis;
      apply.approved = {
        confirmedAt: new Date(nowMillis).toISOString(),
        accountId: binding.accountId,
        region: binding.region,
        stackId: binding.stackId,
        domain: state.config.domain,
        sshTarget: state.config.sshTarget,
      };
      state = yield* persistApply(state, plan, apply, env);
    }

    if (
      !apply.remoteStop ||
      (typeof apply.remoteStop === "object" &&
        apply.remoteStop != null &&
        (apply.remoteStop as Record<string, unknown>).reachable === true &&
        (apply.remoteStop as Record<string, unknown>).stopped !== true)
    ) {
      const rechecked = yield* recheckReviewedRemote(state, plan);
      if (!rechecked.trusted) {
        const nowMillis = yield* Clock.currentTimeMillis;
        apply.remoteStop = {
          ...rechecked.outcome,
          checkedAt: new Date(nowMillis).toISOString(),
        };
        state = yield* persistApply(state, plan, apply, env);
        yield* writeLine(
          "Remote stop skipped because the exact reviewed checkout identity could not be proven; continuing exact AWS cleanup without remote mutation.",
        );
      } else {
        const nowMillis = yield* Clock.currentTimeMillis;
        apply.remoteStopIntent = {
          ...rechecked.evidence,
          command: "docker compose stop",
          volumesRemoved: false,
          recordedAt: new Date(nowMillis).toISOString(),
        };
        state = yield* persistApply(state, plan, apply, env);

        const immediate = yield* recheckReviewedRemote(state, plan);
        if (!immediate.trusted) {
          const t = yield* Clock.currentTimeMillis;
          apply.remoteStop = {
            ...immediate.outcome,
            checkedAt: new Date(t).toISOString(),
          };
          state = yield* persistApply(state, plan, apply, env);
          yield* writeLine(
            "Remote stop skipped because the exact reviewed checkout identity could not be proven; continuing exact AWS cleanup without remote mutation.",
          );
        } else {
          const remoteStop = yield* stopRemoteCompose(
            state,
            immediate.evidence as { remotePath: string },
          );
          if (remoteStop.fatal === true) {
            return yield* failDestroy(String(remoteStop.detail ?? "remote stop failed"));
          }
          const t = yield* Clock.currentTimeMillis;
          apply.remoteStop = { ...remoteStop, attemptedAt: new Date(t).toISOString() };
          state = yield* persistApply(state, plan, apply, env);
          if (remoteStop.reachable && !remoteStop.stopped) {
            return yield* failDestroy(
              "VPS is reachable but `docker compose stop` failed. Fix the remote Compose error and rerun; no AWS resource was deleted.",
            );
          }
          yield* writeLine(
            remoteStop.stopped
              ? "Remote Compose stopped without volume removal."
              : "VPS unreachable; continuing exact AWS cleanup. Checkout, .env, and volumes remain retained.",
          );
        }
      }
    }

    if (
      !isExactKeyDeleteIntent(
        apply.runtimeKeyDeleteIntent as Record<string, unknown> | undefined,
        runtimeAccessKeyId,
        runtimeUserName,
        binding,
      )
    ) {
      const nowMillis = yield* Clock.currentTimeMillis;
      apply.runtimeKeyDeleteIntent = {
        runtimeAccessKeyId,
        runtimeUserName,
        stackId: binding.stackId,
        accountId: binding.accountId,
        region: binding.region,
        recordedAt: new Date(nowMillis).toISOString(),
      };
      state = yield* persistApply(state, plan, apply, env);
    }

    const liveKeys = yield* listRuntimeKeys(run, runtimeUserName).pipe(
      Effect.catch((error) =>
        error instanceof SetupCommandError
          ? Effect.fail(error)
          : liftProviderError(state, env, "iam list-access-keys", error as never),
      ),
    );
    let keyState: { present: boolean; status: string };
    try {
      keyState = assertRuntimeKeyInventory(liveKeys, runtimeAccessKeyId, true);
    } catch (error) {
      return yield* failDestroy(error instanceof Error ? error.message : String(error));
    }
    if (keyState.present) {
      yield* run([
        "iam",
        "delete-access-key",
        "--user-name",
        runtimeUserName,
        "--access-key-id",
        runtimeAccessKeyId,
      ]).pipe(
        Effect.catch((error) => liftProviderError(state, env, "iam delete-access-key", error)),
      );
    }

    if (live.exists) {
      const finalDlq = yield* readDlqCounters(state, run).pipe(
        Effect.catch((error) =>
          error instanceof SetupCommandError
            ? Effect.fail(error)
            : liftProviderError(state, env, "sqs", error as never),
        ),
      );
      try {
        assertDlqEmpty(finalDlq);
      } catch (error) {
        return yield* failDestroy(error instanceof Error ? error.message : String(error));
      }
      const finalKeys = yield* listRuntimeKeys(run, runtimeUserName).pipe(
        Effect.catch((error) =>
          error instanceof SetupCommandError
            ? Effect.fail(error)
            : liftProviderError(state, env, "iam", error as never),
        ),
      );
      try {
        assertRuntimeKeyInventory(finalKeys, runtimeAccessKeyId, true);
      } catch (error) {
        return yield* failDestroy(error instanceof Error ? error.message : String(error));
      }
      const nowMillis = yield* Clock.currentTimeMillis;
      const now = new Date(nowMillis).toISOString();
      apply.runtimeKeyDeleted = {
        runtimeAccessKeyId,
        deletedOrAlreadyAbsent: true,
        checkedAt: now,
      };
      apply.finalDlqCheck = { ...finalDlq, checkedAt: now };
      state = yield* persistApply(state, plan, apply, env);
    }

    if (
      !isExactStackDeleteIntent(
        apply.stackDeleteIntent as Record<string, unknown> | undefined,
        binding,
      )
    ) {
      const nowMillis = yield* Clock.currentTimeMillis;
      apply.stackDeleteIntent = {
        stackId: binding.stackId,
        stackName: binding.stackName,
        accountId: binding.accountId,
        partition: binding.partition,
        region: binding.region,
        requestedAt: new Date(nowMillis).toISOString(),
      };
      state = yield* persistApply(state, plan, apply, env);
    }

    if (live.exists) {
      if (!resumingOwnDeletion) {
        yield* run(["cloudformation", "delete-stack", "--stack-name", binding.stackId]).pipe(
          Effect.catch((error) =>
            liftProviderError(state, env, "cloudformation delete-stack", error),
          ),
        );
      } else {
        yield* writeLine("Resuming the coordinator-requested deletion of the same exact stack ID.");
      }
      const waited = yield* run(
        ["cloudformation", "wait", "stack-delete-complete", "--stack-name", binding.stackId],
        { allowNonZero: true },
      ).pipe(
        Effect.catch((error) =>
          liftProviderError(state, env, "cloudformation wait stack-delete-complete", error),
        ),
      );
      live = yield* describeStack(state, binding.stackId, env);
      if (live.exists) {
        const diagnostics = yield* deletionFailureDiagnostics(state, binding.stackId, env);
        return yield* failDestroy(
          `Deletion of exact stack ${binding.stackId} did not complete (status=${live.status ?? "unknown"}, waiter=${waited.exitCode}). Rerun destroy apply to retry this same exact stack.\n${diagnostics}`,
        );
      }
    }

    const absentStack = yield* describeStack(state, binding.stackId, env);
    const absentResources = yield* listStackResources(run, binding.stackId).pipe(
      Effect.catch((error) =>
        error instanceof SetupCommandError
          ? Effect.fail(error)
          : liftProviderError(state, env, "list-stack-resources", error as never),
      ),
    );
    if (absentStack.exists || !absentResources.absent) {
      return yield* failDestroy("Independent exact stack/resource absence verification failed.");
    }
    {
      const nowMillis = yield* Clock.currentTimeMillis;
      apply.stackDeletionVerified = {
        stackId: binding.stackId,
        accountId: binding.accountId,
        region: binding.region,
        verifiedAbsentAt: new Date(nowMillis).toISOString(),
        describeStacksAbsent: true,
        listStackResourcesAbsent: true,
      };
      state = yield* persistApply(state, plan, apply, env);
    }

    const deployment = yield* store.loadDeploymentEnv(installationId, env);
    const plain = plainDeploymentEnv(deployment);
    delete plain.AWS_ACCESS_KEY_ID;
    delete plain.AWS_SECRET_ACCESS_KEY;
    delete plain.AWS_SESSION_TOKEN;
    yield* store.writeDeploymentEnv(installationId, plain, env);

    {
      const nowMillis = yield* Clock.currentTimeMillis;
      const now = new Date(nowMillis).toISOString();
      apply.localCredentialsRemoved = { completedAt: now };
      apply.completed = {
        completedAt: now,
        exactStackId: binding.stackId,
        retainedResources: [...RETAINED_RESOURCES],
      };
      const latest = yield* store.loadState(installationId, env);
      yield* store.writeState(
        {
          ...latest,
          updatedAt: now,
          plans: {
            ...latest.plans,
            [DESTROY_PLAN_KEY]: sanitizePlanMetadata({
              ...(latest.plans[DESTROY_PLAN_KEY] as Record<string, unknown>),
              apply,
              consumed: true,
              consumedAt: now,
              tombstone: {
                exactStackId: binding.stackId,
                accountId: binding.accountId,
                partition: binding.partition,
                region: binding.region,
                verifiedDeletedAt: now,
              },
            }),
          },
        },
        env,
      );
    }

    yield* reportRetained(
      Array.isArray(plan.externalDkimRecords)
        ? (plan.externalDkimRecords as Array<{ name: string; value: string }>)
        : [],
    );
    yield* writeLine(
      `Verified deletion of exact stack ${binding.stackId}; local AWS runtime credentials removed.`,
    );
    return {
      verified: true as const,
      stackId: binding.stackId,
      retainedResources: [...RETAINED_RESOURCES],
    };
  });
}
