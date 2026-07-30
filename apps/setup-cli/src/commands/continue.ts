import { Effect } from "effect";

import type { AwsCliService } from "../auth/aws-cli.ts";
import { awsCoreStageHandler } from "../aws/core.ts";
import { AwsCommandError } from "../aws/errors.ts";
import { AwsPermissionDeniedError } from "../aws/permissions.ts";
import { ProvisioningPolicyError } from "../aws/provisioning-policy.ts";
import { deployStageHandler, humanGatesStageHandler } from "../deploy/stage.ts";
import {
  AwsAuthError,
  CancellationError,
  NotPortedError,
  ProcessFailedError,
  ProcessSignalError,
  ProcessStartError,
  SetupCommandError,
  SetupStoreError,
  TerminalError,
} from "../errors.ts";
import type { ProcessRunnerService } from "../process-runner.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import type { SetupState } from "../state/schema.ts";
import type { TerminalService } from "../terminal.ts";
import {
  awsFinalizeStageHandler,
  finalValidationStageHandler,
  preSimulatorStageHandler,
  simulatorStageHandler,
} from "../validate/stages.ts";
import { STAGE_ORDER, type StageId } from "./parse.ts";
import { writeLine } from "./prompts.ts";

export type StageHandlerError =
  | SetupCommandError
  | SetupStoreError
  | NotPortedError
  | CancellationError
  | TerminalError
  | AwsAuthError
  | AwsCommandError
  | AwsPermissionDeniedError
  | ProvisioningPolicyError
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError;

export type StageHandlerServices =
  | SetupStoreService
  | TerminalService
  | AwsCliService
  | ProcessRunnerService;

export type StageHandler = {
  readonly isEligible?: (
    state: SetupState,
  ) => Effect.Effect<
    boolean,
    SetupCommandError | SetupStoreError | NotPortedError,
    StageHandlerServices
  >;
  readonly run: (
    state: SetupState,
  ) => Effect.Effect<Record<string, unknown>, StageHandlerError, StageHandlerServices>;
};

/**
 * At most one eligible stage. Missing handlers fail with NotPortedError without checkpoint.
 */
export function runContinue(
  env: NodeJS.ProcessEnv = process.env,
  stageHandlers: Partial<Record<StageId, StageHandler | null>> = {},
): Effect.Effect<void, StageHandlerError, StageHandlerServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);

    if (state.stages.init?.status !== "complete") {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "init has not completed. Run init first.",
        }),
      );
    }

    // null removes a default handler (tests assert NotPorted for unported stages).
    const handlers: Partial<Record<StageId, StageHandler>> = {
      ...defaultStageHandlers(env),
    };
    for (const [stageId, handler] of Object.entries(stageHandlers) as Array<
      [StageId, StageHandler | null | undefined]
    >) {
      if (handler === null) {
        delete handlers[stageId];
      } else if (handler !== undefined) {
        handlers[stageId] = handler;
      }
    }
    const selected = STAGE_ORDER.find((stageId) => state.stages[stageId]?.status !== "complete");

    if (!selected) {
      yield* writeLine("Nothing to continue; all known stages are complete.");
      return;
    }

    const handler = handlers[selected];
    if (!handler) {
      return yield* Effect.fail(
        new NotPortedError({
          stageOrCommand: selected,
          message: `Next stage "${selected}" is not ready in this release yet. Use status to inspect progress; provider commands remain available once implemented.`,
        }),
      );
    }

    const eligible = handler.isEligible ? yield* handler.isEligible(state) : true;
    if (!eligible) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Next stage "${selected}" is blocked until its prerequisites are met. Run doctor/status for details.`,
        }),
      );
    }

    yield* writeLine(`Running one stage: ${selected}`);
    const evidence = yield* handler.run(state);
    if (
      evidence != null &&
      typeof evidence === "object" &&
      evidence.progress === true &&
      evidence.verified !== true
    ) {
      yield* writeLine(
        `Stage "${selected}" recorded progress for one next action; checkpoint not written. Rerun continue.`,
      );
      return;
    }
    if (evidence == null || typeof evidence !== "object" || evidence.verified !== true) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Stage "${selected}" finished without verified evidence; checkpoint not written (exit status alone is insufficient).`,
        }),
      );
    }

    const latestState = yield* store.loadState(installationId, env);
    yield* store.checkpointStage(latestState, selected, evidence, env);
    yield* writeLine(`Stage "${selected}" checkpointed with verified evidence.`);
  });
}

/** Default handlers: T5 aws_core + T6 deploy/validate stages. Tests may inject fakes. */
export function defaultStageHandlers(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<StageId, StageHandler>> {
  return {
    aws_core: awsCoreStageHandler(env),
    human_gates: humanGatesStageHandler(env),
    deploy: deployStageHandler(env),
    aws_finalize: awsFinalizeStageHandler(env),
    validate_pre_simulator: preSimulatorStageHandler(env),
    validate_simulator: simulatorStageHandler(env),
    validate_final: finalValidationStageHandler(env),
  };
}

/** Next pending stage id for guided UX, or null when complete/missing init. */
export function nextPendingStage(state: SetupState): StageId | null {
  if (state.stages.init?.status !== "complete") return null;
  return STAGE_ORDER.find((stageId) => state.stages[stageId]?.status !== "complete") ?? null;
}
