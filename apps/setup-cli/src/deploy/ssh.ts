import { Effect } from "effect";

import {
  CancellationError,
  ProcessFailedError,
  ProcessSignalError,
  ProcessStartError,
  SetupCommandError,
} from "../errors.ts";
import { ProcessRunner, type ProcessResult, type ProcessRunnerService } from "../process-runner.ts";
import type { SetupState } from "../state/schema.ts";
import { assertSshTarget, buildOpenSshArgs } from "./pure.ts";

export type DeployProcessError =
  | SetupCommandError
  | CancellationError
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError;

export type DeployProcessServices = ProcessRunnerService;

export type RunSshOptions = {
  readonly stdin?: string;
  readonly redact?: readonly string[];
  readonly allowNonZero?: boolean;
};

export function mapProcessError(error: unknown): DeployProcessError {
  if (
    error instanceof SetupCommandError ||
    error instanceof CancellationError ||
    error instanceof ProcessFailedError ||
    error instanceof ProcessSignalError ||
    error instanceof ProcessStartError
  ) {
    return error;
  }
  return new SetupCommandError({
    message: error instanceof Error ? error.message : String(error),
  });
}

export function runCaptured(options: {
  readonly command: string;
  readonly args?: readonly string[];
  readonly stdin?: string;
  readonly redact?: readonly string[];
  readonly allowNonZero?: boolean;
}): Effect.Effect<ProcessResult, DeployProcessError, DeployProcessServices> {
  return Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    return yield* runner
      .runCaptured({
        command: options.command,
        args: options.args,
        stdin: options.stdin,
        redact: options.redact,
        allowNonZero: options.allowNonZero,
      })
      .pipe(Effect.mapError(mapProcessError));
  });
}

export function runSsh(
  state: SetupState,
  remoteCommand: string,
  options: RunSshOptions = {},
): Effect.Effect<ProcessResult, DeployProcessError, DeployProcessServices> {
  return Effect.gen(function* () {
    let target: string;
    try {
      target = assertSshTarget(state.config.sshTarget);
    } catch (error) {
      return yield* Effect.fail(mapProcessError(error));
    }
    const result = yield* runCaptured({
      command: "ssh",
      args: buildOpenSshArgs(target, remoteCommand),
      stdin: options.stdin,
      redact: options.redact,
      allowNonZero: options.allowNonZero,
    });
    return result;
  });
}

export type SshHostKeyPolicy = {
  readonly ok: boolean;
  readonly value: string;
  readonly detail: string;
};

/**
 * Reads the effective StrictHostKeyChecking value OpenSSH would use for a target.
 * Never fails: a broken `ssh -G` is reported as `ok: false` with the reason.
 */
export function readSshHostKeyPolicy(
  sshTarget: string,
): Effect.Effect<SshHostKeyPolicy, never, DeployProcessServices> {
  return Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const host = sshTarget.includes("@") ? (sshTarget.split("@").at(-1) ?? sshTarget) : sshTarget;
    const result = yield* runner.runCaptured({ command: "ssh", args: ["-G", host] }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          exitCode: 1 as number | null,
          signal: null as NodeJS.Signals | null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          argv: ["ssh", "-G", host],
        }),
      ),
    );
    if (result.exitCode !== 0) {
      return {
        ok: false,
        value: "",
        detail: result.stderr || result.stdout || "ssh -G failed",
      };
    }

    const match = /^stricthostkeychecking\s+(\S+)/imu.exec(result.stdout);
    const value = match?.[1]?.toLowerCase() ?? "";
    const ok = value === "yes" || value === "accept-new";
    return {
      ok,
      value,
      detail: ok
        ? `StrictHostKeyChecking=${value}`
        : `StrictHostKeyChecking=${value || "unknown"} (require yes or accept-new)`,
    };
  });
}

export function failCommand(message: string): Effect.Effect<never, SetupCommandError> {
  return Effect.fail(new SetupCommandError({ message }));
}

export function trySyncCommand<A>(fn: () => A): Effect.Effect<A, SetupCommandError> {
  return Effect.try({
    try: fn,
    catch: (error) =>
      new SetupCommandError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });
}
