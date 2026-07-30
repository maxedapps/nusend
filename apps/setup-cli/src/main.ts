import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Cause, Clock, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";

import { AwsCliLive, type AwsCliService } from "./auth/aws-cli.ts";
import type { AwsCommandError } from "./aws/errors.ts";
import type { AwsPermissionDeniedError } from "./aws/permissions.ts";
import type { ProvisioningPolicyError } from "./aws/provisioning-policy.ts";
import { parseAndDispatch, type CommandServices } from "./commands/index.ts";
import type { SetupCliError as BaseSetupCliError } from "./errors.ts";
import { CancellationError, UsageError } from "./errors.ts";

export type SetupCliError =
  | BaseSetupCliError
  | ProvisioningPolicyError
  | AwsPermissionDeniedError
  | AwsCommandError;
import { ProcessRunnerLive, type ProcessRunnerService } from "./process-runner.ts";
import { SetupStoreLive, type SetupStoreService } from "./services/setup-store.ts";
import { Terminal, TerminalLive, type TerminalService } from "./terminal.ts";

export { HELP_TEXT, normalizeArgv } from "./commands/index.ts";

export type SetupCliServices = CommandServices;

export const SetupCliLive: Layer.Layer<SetupCliServices> = Layer.mergeAll(
  ProcessRunnerLive,
  TerminalLive,
  SetupStoreLive,
  AwsCliLive.pipe(Layer.provide(ProcessRunnerLive)),
);

export function isMainEntry(argv1: string | undefined, importMetaUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === importMetaUrl;
  } catch {
    try {
      return pathToFileURL(argv1).href === importMetaUrl;
    } catch {
      return false;
    }
  }
}

export function mainProgram(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<void, SetupCliError, SetupCliServices> {
  return Effect.gen(function* () {
    // Exercise Effect Clock at the boundary so timestamps stay injectable via TestClock later.
    yield* Clock.currentTimeMillis;
    yield* parseAndDispatch(argv, env);
  });
}

export function formatTypedError(error: SetupCliError): string {
  switch (error._tag) {
    case "UsageError":
      return error.message;
    case "CancellationError":
      return error.message;
    case "TerminalError":
      return `Terminal error (${error.operation}): ${error.message}`;
    case "ProcessFailedError":
    case "ProcessSignalError":
    case "ProcessStartError":
    case "SetupStoreError":
    case "SetupCommandError":
    case "AwsAuthError":
    case "AwsCommandError":
    case "ProvisioningPolicyError":
    case "AwsPermissionDeniedError":
      return error.message;
    case "NotPortedError":
      return error.message;
  }
}

export function exitCodeForTypedError(error: SetupCliError): number {
  switch (error._tag) {
    case "UsageError":
      return 2;
    case "CancellationError":
      return 130;
    case "ProcessFailedError":
      return typeof error.exitCode === "number" && error.exitCode > 0 ? error.exitCode : 1;
    case "ProcessSignalError":
      return 1;
    case "ProcessStartError":
      return 1;
    case "TerminalError":
      return 1;
    case "SetupStoreError":
      return 1;
    case "SetupCommandError":
      return typeof error.exitCode === "number" && error.exitCode > 0 ? error.exitCode : 1;
    case "NotPortedError":
      return 1;
    case "AwsAuthError":
      return error.reason === "login-cancelled" || error.reason === "cancelled" ? 130 : 1;
    case "AwsCommandError":
      return error.reason === "cancelled" ? 130 : 1;
    case "ProvisioningPolicyError":
      return 1;
    case "AwsPermissionDeniedError":
      return 1;
  }
}

export function exitCodeForCause(cause: Cause.Cause<SetupCliError>): number {
  if (Cause.hasInterruptsOnly(cause)) return 130;
  const typed = Cause.findErrorOption(cause);
  if (Option.isSome(typed)) return exitCodeForTypedError(typed.value);
  return 1;
}

function reportError(error: SetupCliError): Effect.Effect<number, never, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* Terminal;
    // Best-effort diagnostics: if stderr itself fails, still return the mapped code.
    yield* terminal.writeErr(`${formatTypedError(error)}\n`).pipe(Effect.ignore);
    return exitCodeForTypedError(error);
  });
}

function runnableProgram(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<number, never, SetupCliServices> {
  return mainProgram(argv, env).pipe(
    Effect.as(0),
    Effect.catchTags({
      UsageError: (error) => reportError(error),
      CancellationError: (error) => reportError(error),
      TerminalError: (error) => reportError(error),
      ProcessFailedError: (error) => reportError(error),
      ProcessSignalError: (error) => reportError(error),
      ProcessStartError: (error) => reportError(error),
      SetupStoreError: (error) => reportError(error),
      SetupCommandError: (error) => reportError(error),
      NotPortedError: (error) => reportError(error),
      AwsAuthError: (error) => reportError(error),
      AwsCommandError: (error) => reportError(error),
      ProvisioningPolicyError: (error) => reportError(error),
      AwsPermissionDeniedError: (error) => reportError(error),
    }),
  );
}

export async function runWithRuntime(
  runtime: ManagedRuntime.ManagedRuntime<SetupCliServices, never>,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const exit = await runtime.runPromiseExit(runnableProgram(argv, env));
  if (Exit.isSuccess(exit)) return exit.value;

  if (Cause.hasInterruptsOnly(exit.cause)) return 130;

  // Typed failures should already be mapped; remaining failures are unexpected defects.
  // Pretty-print only non-sensitive defect diagnostics (no process env/secret payloads here).
  console.error(Cause.pretty(exit.cause));
  return exitCodeForCause(exit.cause as Cause.Cause<SetupCliError>);
}

export async function runMain(
  argv: readonly string[],
  layer: Layer.Layer<SetupCliServices> = SetupCliLive,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const runtime = ManagedRuntime.make(layer);
  try {
    return await runWithRuntime(runtime, argv, env);
  } finally {
    await runtime.dispose();
  }
}

export { CancellationError, UsageError };
export type { AwsCliService, ProcessRunnerService, SetupStoreService, TerminalService };

if (isMainEntry(process.argv[1], import.meta.url)) {
  const code = await runMain(process.argv.slice(2));
  process.exitCode = code;
}
