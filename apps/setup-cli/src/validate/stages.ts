import { Clock, Effect } from "effect";

import {
  describeStack,
  liftProviderError,
  makeStateRunner,
  resolveCallerContext,
} from "../aws/ops.ts";
import {
  formatDedicatedAssignmentAttestationPrompt,
  formatProvisionerCleanupGuidance,
} from "../aws/permissions.ts";
import { buildStackName } from "../aws/pure.ts";
import { suggestedPermissionSetName } from "../aws/provisioning-policy.ts";
import { verifyFinalizedSubscription } from "../aws/subscription.ts";
import type { StageHandler } from "../commands/continue.ts";
import { ask, askBoolean, writeLine } from "../commands/prompts.ts";
import { posixSingleQuote, runSsh } from "../deploy/index.ts";
import { SetupCommandError } from "../errors.ts";
import { SetupStore } from "../services/setup-store.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import { RUN_SIMULATOR_PHRASE, VALIDATION_PLAN_KEY } from "./constants.ts";
import {
  readDlqCounters,
  runBuiltCliJson,
  verifyAlarmsAndEmail,
  writeValidationPlan,
  type ValidateWorkflowError,
  type ValidateWorkflowServices,
} from "./ops.ts";
import {
  assertDlqEmpty,
  assertProtectedSuppression,
  assertReadinessPayload,
  assertSimulatorStageEvidence,
  buildAlarmExercisePhrase,
  parseSimulatorResult,
  productionGateEvidence,
  productionGateProgress,
  requiredReadinessIds,
} from "./pure.ts";
import { expectedWebhookEndpoint } from "../aws/subscription.ts";

function fail(message: string): Effect.Effect<never, SetupCommandError> {
  return Effect.fail(new SetupCommandError({ message }));
}

export function runReadinessValidation(
  state: SetupState,
  final: boolean,
  env: PathEnvironment,
): Effect.Effect<
  ReturnType<typeof assertReadinessPayload>,
  ValidateWorkflowError,
  ValidateWorkflowServices
> {
  return Effect.gen(function* () {
    const payload = yield* runBuiltCliJson(state, ["ses", "readiness"], env);
    const expected = expectedWebhookEndpoint(state);
    if (
      payload == null ||
      typeof payload !== "object" ||
      (payload as { expectedWebhookUrl?: unknown }).expectedWebhookUrl !== expected
    ) {
      return yield* fail(
        `Built Nusend CLI is connected to readiness for ${String((payload as { expectedWebhookUrl?: unknown })?.expectedWebhookUrl ?? "unknown")}, expected ${expected}. Log in to the deployed Nusend domain.`,
      );
    }
    try {
      return assertReadinessPayload(payload, requiredReadinessIds(state, final));
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error));
    }
  });
}

export function runAwsFinalizeStageVerification(
  env: PathEnvironment = process.env,
  initialState?: SetupState,
): Effect.Effect<Record<string, unknown>, ValidateWorkflowError, ValidateWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId =
      initialState?.installationId ?? (yield* store.resolveInstallationId(env));
    let state = yield* store.loadState(installationId, env);
    yield* resolveCallerContext(state, env);
    const stack = state.aws?.stack as Record<string, unknown> | undefined;
    if (!stack || stack.phase !== "finalize") {
      return yield* fail(
        "AWS finalize is blocked. Run `pnpm nusend:setup aws plan`, review the finalize change set, then run `aws apply`.",
      );
    }
    const live = yield* describeStack(state, buildStackName(state.installationId), env);
    if (
      !live.exists ||
      live.stackId !== stack.stackId ||
      !String(live.status).endsWith("_COMPLETE")
    ) {
      return yield* fail(
        "AWS finalize is blocked: the exact owned stack is absent or not complete.",
      );
    }
    const run = yield* makeStateRunner(state);
    const subscription = yield* verifyFinalizedSubscription(state, run).pipe(
      Effect.catch((error) =>
        error instanceof SetupCommandError
          ? Effect.fail(error)
          : liftProviderError(state, env, "sns subscription verify", error as never),
      ),
    );
    const alarms = yield* verifyAlarmsAndEmail(state, run).pipe(
      Effect.catch((error) =>
        error instanceof SetupCommandError
          ? Effect.fail(error)
          : liftProviderError(state, env, "cloudwatch/sns alarms", error as never),
      ),
    );
    const validation = state.plans?.[VALIDATION_PLAN_KEY] ?? {};
    const exercised = (validation as { alarmExercise?: unknown }).alarmExercise;
    if (!exercised || typeof exercised !== "object") {
      const phrase = buildAlarmExercisePhrase(state);
      yield* writeLine(
        "Exercise the dedicated CloudWatch alarm notification path and verify delivery to the alert mailbox.",
      );
      yield* writeLine("Do not use the SES feedback topic as an alarm action.");
      yield* writeLine(`Type exactly after observing delivery: ${phrase}`);
      const answer = (yield* ask("Alarm exercise evidence: ", true)).trim();
      if (answer !== phrase) {
        return yield* fail(`Evidence rejected. Type exactly: ${phrase}`);
      }
      const nowMillis = yield* Clock.currentTimeMillis;
      const now = new Date(nowMillis).toISOString();
      yield* writeValidationPlan(
        state,
        {
          alarmExercise: {
            verified: true,
            completedAt: now,
            alertEmail: state.config.alertEmail,
          },
        },
        env,
      );
      state = yield* store.loadState(installationId, env);
    }
    return {
      verified: true,
      subscription,
      alarms,
      alarmNotificationExercised: true,
    };
  });
}

export function runPreSimulatorValidation(
  env: PathEnvironment = process.env,
): Effect.Effect<Record<string, unknown>, ValidateWorkflowError, ValidateWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);
    yield* resolveCallerContext(state, env);
    if (state.stages.aws_finalize?.status !== "complete") {
      return yield* fail("Pre-simulator validation requires the verified aws_finalize stage.");
    }
    const readiness = yield* runReadinessValidation(state, false, env);
    const run = yield* makeStateRunner(state);
    const queue = yield* readDlqCounters(state, run).pipe(
      Effect.catch((error) =>
        error instanceof SetupCommandError
          ? Effect.fail(error)
          : liftProviderError(state, env, "sqs get-queue-attributes", error as never),
      ),
    );
    try {
      assertDlqEmpty(queue);
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error));
    }
    return { verified: true, readiness, dlq: queue };
  });
}

export function runSimulatorValidation(
  env: PathEnvironment = process.env,
): Effect.Effect<Record<string, unknown>, ValidateWorkflowError, ValidateWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);
    if (state.stages.validate_pre_simulator?.status !== "complete") {
      return yield* fail("Simulator validation requires completed pre-simulator validation.");
    }
    yield* writeLine(
      "This runs live SES mailbox-simulator sends and may be rate-limited or billed.",
    );
    const answer = (yield* ask(`Type ${RUN_SIMULATOR_PHRASE} to continue: `, true)).trim();
    if (answer !== RUN_SIMULATOR_PHRASE) {
      return yield* fail(`Confirmation rejected. Type exactly: ${RUN_SIMULATOR_PHRASE}`);
    }
    const commands = [
      ["success", "end-to-end"],
      ["bounce", "end-to-end"],
      ["complaint", "end-to-end"],
    ] as const;
    const results = [];
    for (const [scenario, mode] of commands) {
      const remote = `cd ${posixSingleQuote(state.config.remotePath)} && docker compose exec -T api bun apps/service/src/ses/simulator-main.ts ${scenario} --purpose transactional --mode ${mode}`;
      const result = yield* runSsh(state, remote);
      try {
        results.push(parseSimulatorResult(result.stdout, scenario));
      } catch (error) {
        return yield* fail(error instanceof Error ? error.message : String(error));
      }
    }
    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    yield* writeValidationPlan(
      state,
      { simulator: { verified: true, completedAt: now, results } },
      env,
    );
    return { verified: true, confirmation: RUN_SIMULATOR_PHRASE, scenarios: results };
  });
}

function validateProtectedSuppressions(
  state: SetupState,
  env: PathEnvironment,
): Effect.Effect<
  { bounce: unknown; complaint: unknown },
  ValidateWorkflowError,
  ValidateWorkflowServices
> {
  return Effect.gen(function* () {
    const bounceEmail = "bounce@simulator.amazonses.com";
    const complaintEmail = "complaint@simulator.amazonses.com";
    let bouncePayload: unknown;
    let complaintPayload: unknown;
    try {
      bouncePayload = yield* runBuiltCliJson(
        state,
        ["suppressions", "list", "--email", bounceEmail, "--scope", "all", "--reason", "bounce"],
        env,
      );
      complaintPayload = yield* runBuiltCliJson(
        state,
        [
          "suppressions",
          "list",
          "--email",
          complaintEmail,
          "--scope",
          "all",
          "--reason",
          "complaint",
        ],
        env,
      );
    } catch (error) {
      return yield* Effect.fail(error as ValidateWorkflowError);
    }
    try {
      return {
        bounce: assertProtectedSuppression(bouncePayload, "bounce", bounceEmail),
        complaint: assertProtectedSuppression(complaintPayload, "complaint", complaintEmail),
      };
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error));
    }
  });
}

function runProvisionerAssignmentAttestation(
  state: SetupState,
  env: PathEnvironment,
): Effect.Effect<Record<string, unknown>, ValidateWorkflowError, ValidateWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const dedicated =
      state.provisionerPolicy?.dedicatedTemporaryAssignment === true
        ? true
        : state.provisionerPolicy?.dedicatedTemporaryAssignment === false
          ? false
          : null;
    yield* writeLine(
      formatProvisionerCleanupGuidance({
        dedicatedTemporaryAssignment: dedicated,
        installationId: state.installationId,
        permissionSetName: suggestedPermissionSetName(state.installationId),
      }),
    );

    if (dedicated === false) {
      return {
        provisionerAssignment: "nothing-to-remove",
        dedicatedTemporaryAssignment: false,
        note: "Nusend owns nothing to remove in Identity Center for this installation.",
      };
    }

    yield* writeLine(formatDedicatedAssignmentAttestationPrompt());
    const attested = yield* askBoolean("Attest assignment removal / N/A?", false);
    if (!attested) {
      return yield* fail(
        "Final validation requires explicit attestation that the dedicated temporary Identity Center assignment was removed or does not apply.",
      );
    }
    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    const latest = yield* store.loadState(state.installationId, env);
    const evidence = {
      attestedAt: now,
      dedicatedTemporaryAssignment: dedicated,
      humanEvidenceOnly: true,
      providerVerified: false,
    };
    yield* writeValidationPlan(latest, { provisionerAssignmentRemoval: evidence }, env);
    return evidence;
  });
}

export function runFinalValidation(
  env: PathEnvironment = process.env,
): Effect.Effect<Record<string, unknown>, ValidateWorkflowError, ValidateWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    let state = yield* store.loadState(installationId, env);
    if (state.stages.validate_simulator?.status !== "complete") {
      return yield* fail("Final validation requires the completed simulator stage.");
    }
    try {
      assertSimulatorStageEvidence(state.stages.validate_simulator.evidence);
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error));
    }

    const next = productionGateProgress(state).find((gate) => !gate.complete);
    if (next) {
      yield* writeLine(`Manual production gate (one next action): ${next.title}`);
      yield* writeLine(next.action);
      yield* writeLine("This evidence is operator-controlled and is not marked automated.");
      yield* writeLine(`Type exactly: ${next.phrase}`);
      const answer = (yield* ask("Production gate evidence: ", true)).trim();
      if (answer !== next.phrase) {
        return yield* fail(`Evidence rejected. Type exactly: ${next.phrase}`);
      }
      const nowMillis = yield* Clock.currentTimeMillis;
      const now = new Date(nowMillis).toISOString();
      yield* writeValidationPlan(
        state,
        next.id === "alarm_delivery"
          ? { alarmExercise: { verified: true, completedAt: now } }
          : {
              productionGates: {
                ...productionGateEvidence(state),
                [next.id]: { verified: true, completedAt: now },
              },
            },
        env,
      );
      state = yield* store.loadState(installationId, env);
      const remaining = productionGateProgress(state).filter((gate) => !gate.complete);
      if (remaining.length > 0) {
        return {
          verified: false,
          progress: true,
          completedGate: next.id,
          remaining: remaining.map((gate) => gate.id),
        };
      }
    }

    yield* resolveCallerContext(state, env);
    const readiness = yield* runReadinessValidation(state, true, env);
    const suppressions = yield* validateProtectedSuppressions(state, env);
    const run = yield* makeStateRunner(state);
    const queue = yield* readDlqCounters(state, run).pipe(
      Effect.catch((error) =>
        error instanceof SetupCommandError
          ? Effect.fail(error)
          : liftProviderError(state, env, "sqs get-queue-attributes", error as never),
      ),
    );
    try {
      assertDlqEmpty(queue);
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error));
    }

    const assignment = yield* runProvisionerAssignmentAttestation(state, env);

    return {
      verified: true,
      readiness,
      suppressions,
      dlq: queue,
      productionGates: productionGateProgress(state).map((gate) => gate.id),
      alarmNotificationExercised: true,
      provisionerAssignmentRemoval: assignment,
    };
  });
}

export function awsFinalizeStageHandler(env: PathEnvironment = process.env): StageHandler {
  return {
    isEligible: (state) => Effect.succeed(state.stages.deploy?.status === "complete"),
    run: (state) => runAwsFinalizeStageVerification(env, state),
  };
}

export function preSimulatorStageHandler(env: PathEnvironment = process.env): StageHandler {
  return {
    isEligible: (state) => Effect.succeed(state.stages.aws_finalize?.status === "complete"),
    run: () => runPreSimulatorValidation(env),
  };
}

export function simulatorStageHandler(env: PathEnvironment = process.env): StageHandler {
  return {
    isEligible: (state) =>
      Effect.succeed(state.stages.validate_pre_simulator?.status === "complete"),
    run: () => runSimulatorValidation(env),
  };
}

export function finalValidationStageHandler(env: PathEnvironment = process.env): StageHandler {
  return {
    isEligible: (state) => Effect.succeed(state.stages.validate_simulator?.status === "complete"),
    run: () => runFinalValidation(env),
  };
}
