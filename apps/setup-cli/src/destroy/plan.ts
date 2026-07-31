import { Clock, Effect } from "effect";

import type { AwsWorkflowError, AwsWorkflowServices } from "../aws/ops.ts";
import {
  describeStack,
  liftProviderError,
  makeStateRunner,
  resolveCallerContext,
} from "../aws/ops.ts";
import { isActiveStackStatus } from "../aws/pure.ts";
import { writeLine } from "../commands/prompts.ts";
import {
  ProcessFailedError,
  ProcessSignalError,
  ProcessStartError,
  SetupCommandError,
} from "../errors.ts";
import type { ProcessRunnerService } from "../process-runner.ts";
import { SetupStore } from "../services/setup-store.ts";
import type { PathEnvironment } from "../state/paths.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import { readDlqCounters } from "../validate/ops.ts";
import { assertDlqEmpty } from "../validate/pure.ts";
import {
  inventoryAlarms,
  inventorySubscriptions,
  inspectTrustedRemote,
  listRuntimeKeys,
  listStackResources,
} from "./inventory.ts";
import {
  assertInitialStackCreationProof,
  assertRuntimeKeyInventory,
  buildDestroyConfirmationPhrase,
  DESTROY_PLAN_KEY,
  DESTROY_PLAN_VERSION,
  externalDkimRecords,
  fingerprintDestroyPlan,
  isExactKeyDeleteIntent,
  isExactStackDeleteIntent,
  RETAINED_RESOURCES,
  stackLastUpdatedTime,
  type StackCreationBinding,
} from "./pure.ts";

export type DestroyWorkflowError =
  | AwsWorkflowError
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError;

export type DestroyWorkflowServices = AwsWorkflowServices | ProcessRunnerService;

function fail(message: string): Effect.Effect<never, SetupCommandError> {
  return Effect.fail(new SetupCommandError({ message }));
}

function reportRetained(
  dkim: Array<{ name: string; value: string }>,
): Effect.Effect<
  void,
  import("../errors.ts").TerminalError,
  import("../terminal.ts").TerminalService
> {
  return Effect.gen(function* () {
    yield* writeLine("RETAINED — destroy will NOT remove these external/data resources:");
    for (const item of RETAINED_RESOURCES) yield* writeLine(`  - ${item}`);
    if (dkim.length > 0) {
      yield* writeLine(
        "Manual external DNS cleanup after deletion (not performed by the coordinator):",
      );
      for (const record of dkim) yield* writeLine(`  CNAME ${record.name} -> ${record.value}`);
    }
  });
}

function assertCallerBinding(
  state: Parameters<typeof resolveCallerContext>[0],
  binding: StackCreationBinding,
  env: PathEnvironment,
) {
  return Effect.gen(function* () {
    const caller = yield* resolveCallerContext(state, env);
    if (
      caller.accountId !== binding.accountId ||
      caller.region !== binding.region ||
      caller.partition !== binding.partition
    ) {
      return yield* fail(
        "Destroy is blocked: caller account/region/partition differs from exact stack state.",
      );
    }
    return caller;
  });
}

export function runDestroyPlan(
  env: PathEnvironment = process.env,
): Effect.Effect<Record<string, unknown>, DestroyWorkflowError, DestroyWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);

    let binding: StackCreationBinding;
    try {
      binding = assertInitialStackCreationProof(state);
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error));
    }
    yield* assertCallerBinding(state, binding, env);

    const previousApply = state.plans?.[DESTROY_PLAN_KEY]?.apply;
    // A new plan carries forward the resume checkpoints but never the approval:
    // a confirmation only ever authorizes the plan it was given for.
    const { approved: _discardedApproval, ...apply } =
      previousApply && typeof previousApply === "object"
        ? (previousApply as Record<string, unknown>)
        : {};
    const stackDeleteIntent =
      apply.stackDeleteIntent && typeof apply.stackDeleteIntent === "object"
        ? (apply.stackDeleteIntent as Record<string, unknown>)
        : undefined;

    const live = yield* describeStack(state, binding.stackId, env);
    if (live.exists) {
      if (live.stackId !== binding.stackId) {
        return yield* fail("Destroy is blocked: live stack ID differs from stored exact stack ID.");
      }
      if (isActiveStackStatus(live.status)) {
        return yield* fail(`Destroy is blocked: stack operation is active (${live.status}).`);
      }
    } else if (!isExactStackDeleteIntent(stackDeleteIntent, binding)) {
      return yield* fail(
        "Destroy is blocked: exact stack is unexpectedly missing without its durable deletion-request checkpoint.",
      );
    }

    const outputs = state.aws?.stack?.outputs as Record<string, unknown> | undefined;
    if (!outputs || typeof outputs !== "object") {
      return yield* fail("Destroy is blocked: stored stack outputs are missing.");
    }
    const runtimeUserName = String(outputs.RuntimeUserName ?? "");
    const runtimeAccessKeyId = String(
      (state.aws as { runtimeAccessKeyId?: unknown } | undefined)?.runtimeAccessKeyId ?? "",
    );
    if (!runtimeUserName || !runtimeAccessKeyId) {
      return yield* fail(
        `Destroy is blocked: runtime user/key ownership state is incomplete. Delete stack ${binding.stackName} in the CloudFormation console instead.`,
      );
    }
    const keyDeleteIntent =
      apply.runtimeKeyDeleteIntent && typeof apply.runtimeKeyDeleteIntent === "object"
        ? (apply.runtimeKeyDeleteIntent as Record<string, unknown>)
        : undefined;

    const run = yield* makeStateRunner(state);
    const keyInventory = yield* listRuntimeKeys(run, runtimeUserName).pipe(
      Effect.catch((error) =>
        error instanceof SetupCommandError
          ? Effect.fail(error)
          : liftProviderError(state, env, "iam list-access-keys", error as never),
      ),
    );
    let keyState: { present: boolean; status: string };
    try {
      keyState = assertRuntimeKeyInventory(
        keyInventory,
        runtimeAccessKeyId,
        isExactKeyDeleteIntent(keyDeleteIntent, runtimeAccessKeyId, runtimeUserName, binding),
      );
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error));
    }

    const dlq = live.exists
      ? yield* readDlqCounters(state, run).pipe(
          Effect.catch((error) =>
            error instanceof SetupCommandError
              ? Effect.fail(error)
              : liftProviderError(state, env, "sqs get-queue-attributes", error as never),
          ),
        )
      : null;
    if (dlq) {
      try {
        assertDlqEmpty(dlq);
      } catch (error) {
        return yield* fail(error instanceof Error ? error.message : String(error));
      }
    }

    const resources = live.exists
      ? yield* listStackResources(run, binding.stackId).pipe(
          Effect.catch((error) =>
            error instanceof SetupCommandError
              ? Effect.fail(error)
              : liftProviderError(
                  state,
                  env,
                  "cloudformation list-stack-resources",
                  error as never,
                ),
          ),
        )
      : { absent: true, resources: [] as Array<Record<string, string>> };

    const feedbackTopicArn = String(outputs.FeedbackTopicArn ?? "");
    const alarmTopicArn = String(outputs.AlarmTopicArn ?? "");
    const subscriptions = live.exists
      ? {
          feedback: yield* inventorySubscriptions(run, feedbackTopicArn).pipe(
            Effect.catch((error) =>
              error instanceof SetupCommandError
                ? Effect.fail(error)
                : liftProviderError(state, env, "sns subscriptions", error as never),
            ),
          ),
          alarm: yield* inventorySubscriptions(run, alarmTopicArn).pipe(
            Effect.catch((error) =>
              error instanceof SetupCommandError
                ? Effect.fail(error)
                : liftProviderError(state, env, "sns subscriptions", error as never),
            ),
          ),
        }
      : { feedback: [], alarm: [] };
    const alarms = live.exists
      ? yield* inventoryAlarms(state, run).pipe(
          Effect.catch((error) =>
            error instanceof SetupCommandError
              ? Effect.fail(error)
              : liftProviderError(state, env, "cloudwatch describe-alarms", error as never),
          ),
        )
      : [];
    const remote = yield* inspectTrustedRemote(state);
    const dkim = externalDkimRecords(state);
    const nowMillis = yield* Clock.currentTimeMillis;
    const plannedAt = new Date(nowMillis).toISOString();

    const plan = sanitizePlanMetadata({
      version: DESTROY_PLAN_VERSION,
      installationId,
      accountId: binding.accountId,
      partition: binding.partition,
      region: binding.region,
      stackId: binding.stackId,
      stackName: binding.stackName,
      stackStatus: live.status ?? "ABSENT_AFTER_CHECKPOINT",
      stackExists: live.exists,
      stackLastUpdatedTime: stackLastUpdatedTime(live.raw),
      domain: state.config.domain,
      sshTarget: state.config.sshTarget,
      remotePath: state.config.remotePath,
      runtimeUserName,
      runtimeAccessKeyId,
      runtimeKeys: keyInventory.keys,
      runtimeKeyState: keyState,
      dlq,
      stackResources: resources.resources,
      subscriptions,
      alarms,
      remote,
      retainedResources: [...RETAINED_RESOURCES],
      externalDkimRecords: dkim,
      creationProofFingerprint: String(binding.proof.fingerprint),
      creationChangeSetArn: String(binding.proof.changeSetArn),
      plannedAt,
      consumed: false,
      apply,
    });
    plan.fingerprint = fingerprintDestroyPlan(plan);

    yield* store.writeState(
      {
        ...state,
        updatedAt: plannedAt,
        plans: { ...state.plans, [DESTROY_PLAN_KEY]: plan },
      },
      env,
    );

    yield* writeLine(`Destroy plan for exact stack ID: ${binding.stackId}`);
    yield* writeLine(
      `  account=${binding.accountId} partition=${binding.partition} region=${binding.region}`,
    );
    yield* writeLine(`  status=${plan.stackStatus} resources=${resources.resources.length}`);
    yield* writeLine(
      `  runtime key=${keyState.status}; subscriptions=${subscriptions.feedback.length + subscriptions.alarm.length}; alarms=${alarms.length}`,
    );
    yield* writeLine(
      `  DLQ=${dlq ? `visible=${dlq.visible}, notVisible=${dlq.notVisible}, delayed=${dlq.delayed}` : "already removed after checkpoint"}`,
    );
    yield* writeLine(
      `  VPS=${String(remote.status)}${remote.stopReviewed ? " (exact checkout reviewed)" : " (remote stop skipped; AWS cleanup remains available)"}`,
    );
    yield* writeLine(`  fingerprint=${plan.fingerprint}`);
    yield* reportRetained(dkim);
    yield* writeLine(`Type on apply: ${buildDestroyConfirmationPhrase(plan as never)}`);
    return plan;
  });
}

export { assertCallerBinding, reportRetained, fail as failDestroy };
