import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { Context, Effect, Layer } from "effect";

import {
  CancellationError,
  ProcessFailedError,
  ProcessSignalError,
  ProcessStartError,
} from "./errors.ts";

export type ProcessEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type RunCapturedOptions = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: ProcessEnv;
  readonly stdin?: string;
  readonly redact?: readonly string[];
  readonly allowNonZero?: boolean;
};

export type RunInheritedOptions = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: ProcessEnv;
};

export type ProcessResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly argv: readonly string[];
};

export type ProcessRunnerError =
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError
  | CancellationError;

export interface ProcessRunnerService {
  readonly runCaptured: (
    options: RunCapturedOptions,
  ) => Effect.Effect<ProcessResult, ProcessRunnerError>;
  readonly runInherited: (
    options: RunInheritedOptions,
  ) => Effect.Effect<ProcessResult, ProcessRunnerError>;
}

export const ProcessRunner = Context.Service<ProcessRunnerService>("nusend/setup/ProcessRunner");

/**
 * Inherited-terminal mode is only authorized for AWS SSO interaction.
 * Enforce this helper at the AWS layer before calling `runInherited`.
 * Allowed:
 * - `aws configure sso ...`
 * - `aws sso login ...`
 */
export const INHERITED_AWS_SSO_COMMAND = "aws";

export type InheritedAwsSsoKind = "configure-sso" | "sso-login";

export function classifyInheritedAwsSso(
  command: string,
  args: readonly string[],
): InheritedAwsSsoKind | null {
  if (command !== INHERITED_AWS_SSO_COMMAND) return null;
  if (args[0] === "configure" && args[1] === "sso") return "configure-sso";
  if (args[0] === "sso" && args[1] === "login") return "sso-login";
  return null;
}

export function assertInheritedAwsSsoAllowed(
  command: string,
  args: readonly string[],
): InheritedAwsSsoKind {
  const kind = classifyInheritedAwsSso(command, args);
  if (kind === null) {
    throw new Error(
      `Inherited terminal mode is restricted to \`aws configure sso\` and \`aws sso login\` (got ${formatArgv([command, ...args])}).`,
    );
  }
  return kind;
}

export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

export function formatArgv(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function isAbortError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  return name === "AbortError" || code === "ABORT_ERR";
}

type InternalRunOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: ProcessEnv;
  readonly stdin?: string;
  readonly redact: readonly string[];
  readonly allowNonZero: boolean;
  readonly mode: "captured" | "inherited";
  readonly signal: AbortSignal;
};

function runNodeProcess(options: InternalRunOptions): Promise<ProcessResult> {
  const command = options.command;
  if (typeof command !== "string" || command.length === 0) {
    return Promise.reject(new Error("ProcessRunner requires a command string."));
  }

  const args = Object.freeze([...options.args].map(String));
  const argv = Object.freeze([command, ...args]);
  const redact = options.redact;

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams | ReturnType<typeof spawn>;
    let aborted = options.signal.aborted;
    const onAbort = () => {
      aborted = true;
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // When env is provided it is the complete child environment (no process.env merge).
      // Callers that need a sanitized AWS env must pass the full map from buildSanitizedAwsEnv.
      const childEnv =
        options.env !== undefined
          ? Object.fromEntries(
              Object.entries(options.env).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : process.env;
      child = spawn(command, args, {
        cwd: options.cwd,
        env: childEnv,
        stdio: options.mode === "captured" ? ["pipe", "pipe", "pipe"] : "inherit",
        shell: false,
        signal: options.signal,
      });
    } catch (error) {
      options.signal.removeEventListener("abort", onAbort);
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    if (options.mode === "captured") {
      const captured = child as ChildProcessWithoutNullStreams;
      captured.stdout.setEncoding("utf8");
      captured.stderr.setEncoding("utf8");
      captured.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      captured.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      if (options.stdin != null) {
        captured.stdin.end(String(options.stdin));
      } else {
        captured.stdin.end();
      }
    }

    const finish = (error: unknown, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
        return;
      }
      resolve(result as ProcessResult);
    };

    child.on("error", (error) => {
      if (aborted || isAbortError(error) || options.signal.aborted) {
        const cancellation = new CancellationError({
          message: `Command cancelled: ${formatArgv(argv)}`,
        });
        finish(cancellation);
        return;
      }
      const wrapped = new ProcessStartError({
        argv,
        message: `Failed to start ${command}: ${redactText(error.message, redact)}`,
        cause: error,
      });
      finish(wrapped);
    });

    child.on("close", (exitCode, signal) => {
      if (aborted || options.signal.aborted) {
        finish(
          new CancellationError({
            message: `Command cancelled: ${formatArgv(argv)}`,
          }),
        );
        return;
      }

      const result: ProcessResult = {
        exitCode,
        signal: signal ?? null,
        // Inherited mode must never capture browser/device/MFA output.
        stdout: options.mode === "captured" ? stdout : "",
        stderr: options.mode === "captured" ? stderr : "",
        argv,
      };

      if (signal) {
        finish(
          new ProcessSignalError({
            signal,
            exitCode,
            argv,
            stdout: redactText(result.stdout, redact),
            stderr: redactText(result.stderr, redact),
            message: redactText(
              `Command terminated by signal ${signal}: ${formatArgv(argv)}`,
              redact,
            ),
          }),
        );
        return;
      }

      if (exitCode !== 0 && !options.allowNonZero) {
        finish(
          new ProcessFailedError({
            exitCode,
            argv,
            stdout: redactText(result.stdout, redact),
            stderr: redactText(result.stderr, redact),
            message: redactText(
              `Command failed (${exitCode}): ${formatArgv(argv)}\n${result.stderr || result.stdout}`,
              redact,
            ),
          }),
        );
        return;
      }

      finish(null, {
        ...result,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    });
  });
}

function mapThrownProcessError(error: unknown, argv: readonly string[]): ProcessRunnerError {
  if (
    error instanceof ProcessFailedError ||
    error instanceof ProcessSignalError ||
    error instanceof ProcessStartError ||
    error instanceof CancellationError
  ) {
    return error;
  }
  if (isAbortError(error)) {
    return new CancellationError({ message: `Command cancelled: ${formatArgv(argv)}` });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProcessStartError({
    argv,
    message: `Failed to run ${formatArgv(argv)}: ${message}`,
    cause: error,
  });
}

function makeProcessRunner(): ProcessRunnerService {
  return {
    runCaptured: (options) => {
      const args = options.args ?? [];
      const argv = [options.command, ...args];
      return Effect.tryPromise({
        try: (signal) =>
          runNodeProcess({
            command: options.command,
            args,
            cwd: options.cwd,
            env: options.env,
            stdin: options.stdin,
            redact: options.redact ?? [],
            allowNonZero: options.allowNonZero ?? false,
            mode: "captured",
            signal,
          }),
        catch: (error) => mapThrownProcessError(error, argv),
      });
    },
    runInherited: (options) => {
      const args = options.args ?? [];
      const argv = [options.command, ...args];
      return Effect.tryPromise({
        try: (signal) =>
          runNodeProcess({
            command: options.command,
            args,
            cwd: options.cwd,
            env: options.env,
            redact: [],
            allowNonZero: false,
            mode: "inherited",
            signal,
          }),
        catch: (error) => mapThrownProcessError(error, argv),
      });
    },
  };
}

export const ProcessRunnerLive: Layer.Layer<ProcessRunnerService> =
  Layer.succeed(ProcessRunner)(makeProcessRunner());

export type ProcessRunnerFakeHandlers = {
  readonly runCaptured?: ProcessRunnerService["runCaptured"];
  readonly runInherited?: ProcessRunnerService["runInherited"];
};

export function ProcessRunnerFake(
  handlers: ProcessRunnerFakeHandlers = {},
): Layer.Layer<ProcessRunnerService> {
  const service: ProcessRunnerService = {
    runCaptured:
      handlers.runCaptured ??
      ((_options) =>
        Effect.fail(
          new ProcessStartError({
            argv: ["<fake>"],
            message: "ProcessRunnerFake.runCaptured was not configured.",
            cause: undefined,
          }),
        )),
    runInherited:
      handlers.runInherited ??
      ((_options) =>
        Effect.fail(
          new ProcessStartError({
            argv: ["<fake>"],
            message: "ProcessRunnerFake.runInherited was not configured.",
            cause: undefined,
          }),
        )),
  };
  return Layer.succeed(ProcessRunner)(service);
}
