import { Effect } from "effect";

import { runAwsAuthCommand, type AwsCliService } from "../auth/index.ts";
import { runAwsApply } from "../aws/apply.ts";
import { AwsCommandError } from "../aws/errors.ts";
import { AwsPermissionDeniedError, runAwsPermissionsCommand } from "../aws/permissions.ts";
import { runAwsPlan } from "../aws/plan.ts";
import { ProvisioningPolicyError } from "../aws/provisioning-policy.ts";
import { runDeployApply } from "../deploy/apply.ts";
import { runDeployPlan } from "../deploy/plan.ts";
import { runDestroyApply } from "../destroy/apply.ts";
import { runDestroyPlan } from "../destroy/plan.ts";
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
  UsageError,
} from "../errors.ts";
import type { ProcessRunnerService } from "../process-runner.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import type { TerminalService } from "../terminal.ts";
import {
  runFinalValidation,
  runPreSimulatorValidation,
  runSimulatorValidation,
} from "../validate/index.ts";
import { nextPendingStage, runContinue } from "./continue.ts";
import { runDoctor } from "./doctor.ts";
import { runInit } from "./init.ts";
import { HELP_TEXT, parseSetupArgv, type ParsedCommand } from "./parse.ts";
import { askBoolean, writeLine } from "./prompts.ts";
import { runStatus } from "./status.ts";

export type CommandServices =
  | SetupStoreService
  | TerminalService
  | ProcessRunnerService
  | AwsCliService;

export type CommandError =
  | UsageError
  | SetupCommandError
  | SetupStoreError
  | AwsAuthError
  | AwsCommandError
  | NotPortedError
  | CancellationError
  | TerminalError
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError
  | ProvisioningPolicyError
  | AwsPermissionDeniedError;

export function dispatchCommand(
  command: ParsedCommand,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<void, CommandError, CommandServices> {
  switch (command.kind) {
    case "help":
      return writeLine(HELP_TEXT.trimEnd());
    case "guided":
      return runGuided(env);
    case "init":
      return runInit(env).pipe(Effect.asVoid);
    case "doctor":
      return runDoctor({
        env,
        skipRemoteDoctorChecks: env.NUSEND_SETUP_SKIP_REMOTE === "1",
      });
    case "status":
      return runStatus(command.refresh, env);
    case "continue":
      return runContinue(env);
    case "aws":
      if (command.action === "auth") {
        return runAwsAuthCommand(env).pipe(Effect.asVoid);
      }
      if (command.action === "permissions") {
        return runAwsPermissionsCommand(env).pipe(Effect.asVoid);
      }
      if (command.action === "plan") {
        return runAwsPlan(env).pipe(Effect.asVoid);
      }
      if (command.action === "apply") {
        return runAwsApply(env).pipe(Effect.asVoid);
      }
      return Effect.fail(
        new NotPortedError({
          stageOrCommand: `aws ${command.action}`,
          message: `aws ${command.action} is not ported yet.`,
        }),
      );
    case "deploy":
      if (command.action === "plan") {
        return runDeployPlan(env).pipe(Effect.asVoid);
      }
      if (command.action === "apply") {
        return runDeployApply(env).pipe(Effect.asVoid);
      }
      return Effect.fail(
        new UsageError({ message: `Unknown deploy action: ${String(command.action)}` }),
      );
    case "validate":
      if (command.action === "pre-simulator") {
        return runPreSimulatorValidation(env).pipe(Effect.asVoid);
      }
      if (command.action === "simulator") {
        return runSimulatorValidation(env).pipe(Effect.asVoid);
      }
      if (command.action === "final") {
        return runFinalValidation(env).pipe(Effect.asVoid);
      }
      return Effect.fail(
        new UsageError({ message: `Unknown validate action: ${String(command.action)}` }),
      );
    case "destroy":
      if (command.action === "plan") {
        return runDestroyPlan(env).pipe(Effect.asVoid);
      }
      if (command.action === "apply") {
        return runDestroyApply(env).pipe(Effect.asVoid);
      }
      return Effect.fail(
        new UsageError({ message: `Unknown destroy action: ${String(command.action)}` }),
      );
    default: {
      const _exhaustive: never = command;
      return Effect.fail(
        new UsageError({ message: `Unhandled command: ${JSON.stringify(_exhaustive)}` }),
      );
    }
  }
}

/**
 * Bare start: init when no installation; else show/run one next verified action path.
 */
export function runGuided(
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<void, CommandError, CommandServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;

    const hasInstall = yield* store.resolveInstallationId(env).pipe(
      Effect.as(true),
      Effect.catchTag("SetupStoreError", (error) =>
        error.reason === "not-found" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );

    if (!hasInstall) {
      yield* writeLine("No active installation. Starting guided init.");
      yield* runInit(env);
      return;
    }

    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);
    const next = nextPendingStage(state);

    if (next == null) {
      if (state.stages.init?.status !== "complete") {
        yield* writeLine(
          "Installation exists but init is incomplete. Inspect with status; refuse silent re-init.",
        );
        return;
      }
      yield* writeLine("All known stages are complete. Use status or recovery commands as needed.");
      return;
    }

    yield* writeLine(`Next verified action: continue stage "${next}".`);
    const proceed = yield* askBoolean(`Run continue for stage "${next}" now?`, true);
    if (!proceed) {
      yield* writeLine("Skipped. Re-run with continue when ready.");
      return;
    }
    yield* runContinue(env);
  });
}

export function parseAndDispatch(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<void, CommandError, CommandServices> {
  return Effect.gen(function* () {
    const command = yield* Effect.try({
      try: () => parseSetupArgv(argv),
      catch: (error) =>
        error instanceof UsageError
          ? error
          : new UsageError({
              message: error instanceof Error ? error.message : String(error),
            }),
    });
    yield* dispatchCommand(command, env);
  });
}
