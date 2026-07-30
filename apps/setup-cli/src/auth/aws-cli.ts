import { Context, Effect, Layer } from "effect";

import {
  AwsAuthError,
  CancellationError,
  ProcessFailedError,
  ProcessSignalError,
  ProcessStartError,
} from "../errors.ts";
import { AwsCommandError } from "../aws/errors.ts";
import { classifyAwsCliFailureText } from "../aws/schemas.ts";
import {
  assertInheritedAwsSsoAllowed,
  ProcessRunner,
  type ProcessRunnerError,
  type ProcessRunnerService,
  type ProcessResult,
} from "../process-runner.ts";
import { buildSanitizedAwsEnv, type ProcessEnvLike } from "./sanitized-env.ts";
import {
  decodeStsCallerIdentity,
  isAccessDeniedText,
  isSsoSessionExpiredText,
  resolveCallerFromIdentity,
  type ResolvedCallerContext,
} from "./sts.ts";
import { assertSsoProvenance, parseListProfiles } from "./profile.ts";

export type AwsCliService = {
  /** Captured AWS CLI with sanitized env (no ambient credentials). */
  readonly runCaptured: (
    args: readonly string[],
    options?: { readonly allowNonZero?: boolean; readonly redact?: readonly string[] },
  ) => Effect.Effect<ProcessResult, AwsAuthError | CancellationError>;

  /**
   * Provider command with explicit SSO profile + workload region.
   * Classifies auth expiry, authorization denial, throttling, and timeout separately.
   * Never merges process.env; uses the sanitized AWS child env only.
   */
  readonly runProfileCommand: (
    profile: string,
    region: string,
    command: readonly string[],
    options?: { readonly allowNonZero?: boolean; readonly redact?: readonly string[] },
  ) => Effect.Effect<ProcessResult, AwsCommandError | CancellationError>;

  /**
   * Inherited-stdio AWS SSO only (`configure sso` / `sso login`).
   * Never captures browser URLs, device codes, or MFA output.
   */
  readonly runInheritedSso: (
    args: readonly string[],
  ) => Effect.Effect<ProcessResult, AwsAuthError | CancellationError>;

  readonly listProfiles: () => Effect.Effect<readonly string[], AwsAuthError | CancellationError>;

  readonly configureGet: (
    profileName: string,
    key: string,
  ) => Effect.Effect<string | null, AwsAuthError | CancellationError>;

  readonly configureGetSsoSession: (
    sessionName: string,
    key: string,
  ) => Effect.Effect<string | null, AwsAuthError | CancellationError>;

  readonly configureList: (
    profileName: string,
  ) => Effect.Effect<string, AwsAuthError | CancellationError>;

  readonly getCallerIdentity: (
    profileName: string,
    region: string,
  ) => Effect.Effect<ResolvedCallerContext, AwsAuthError | CancellationError>;

  /**
   * Provenance + STS check. Classifies expired SSO separately from AccessDenied/malformed.
   */
  readonly verifyProfileSession: (
    profileName: string,
    region: string,
  ) => Effect.Effect<ResolvedCallerContext, AwsAuthError | CancellationError>;

  readonly awsVersionText: () => Effect.Effect<string, AwsAuthError | CancellationError>;
};

function mapProviderProcessError(
  error: ProcessRunnerError,
  operation: string,
): AwsCommandError | CancellationError {
  if (error instanceof CancellationError) return error;

  if (error instanceof ProcessFailedError) {
    const text = `${error.stdout}\n${error.stderr}`;
    const classified = classifyAwsCliFailureText(text);
    return new AwsCommandError({
      message: error.message,
      reason: classified ?? "failed",
      operation,
      stdout: error.stdout,
      stderr: error.stderr,
      exitCode: error.exitCode,
      cause: error,
    });
  }

  if (error instanceof ProcessSignalError) {
    return new AwsCommandError({
      message: error.message,
      reason: "failed",
      operation,
      stdout: error.stdout,
      stderr: error.stderr,
      exitCode: error.exitCode,
      cause: error,
    });
  }

  if (error instanceof ProcessStartError) {
    return new AwsCommandError({
      message: error.message,
      reason: "failed",
      operation,
      cause: error,
    });
  }

  return new AwsCommandError({
    message: "Unexpected AWS CLI process failure.",
    reason: "failed",
    operation,
    cause: error,
  });
}

export const AwsCli = Context.Service<AwsCliService>("nusend/setup/AwsCli");

export type AwsCliOptions = {
  readonly parentEnv?: ProcessEnvLike;
};

function mapProcessError(error: ProcessRunnerError): AwsAuthError | CancellationError {
  if (error instanceof CancellationError) return error;

  if (error instanceof ProcessFailedError) {
    const text = `${error.stdout}\n${error.stderr}`;
    if (isSsoSessionExpiredText(text)) {
      return new AwsAuthError({
        message: "AWS SSO session is missing or expired for this profile.",
        reason: "expired-session",
        cause: error,
      });
    }
    if (isAccessDeniedText(text)) {
      return new AwsAuthError({
        message: "AWS returned AccessDenied for this call (not treated as reauthentication).",
        reason: "access-denied",
        cause: error,
      });
    }
    return new AwsAuthError({
      message: error.message,
      reason: "login-failed",
      cause: error,
    });
  }

  if (error instanceof ProcessSignalError) {
    return new AwsAuthError({
      message: error.message,
      reason: "login-failed",
      cause: error,
    });
  }

  if (error instanceof ProcessStartError) {
    return new AwsAuthError({
      message: error.message,
      reason: "login-failed",
      cause: error,
    });
  }

  return new AwsAuthError({
    message: "Unexpected AWS CLI process failure.",
    reason: "login-failed",
    cause: error,
  });
}

function makeAwsCli(runner: ProcessRunnerService, options: AwsCliOptions = {}): AwsCliService {
  const parentEnv = options.parentEnv ?? process.env;

  const sanitized = () => buildSanitizedAwsEnv(parentEnv);

  const runCaptured: AwsCliService["runCaptured"] = (args, runOptions = {}) =>
    runner
      .runCaptured({
        command: "aws",
        args,
        env: sanitized(),
        allowNonZero: runOptions.allowNonZero ?? false,
        redact: runOptions.redact,
      })
      .pipe(Effect.mapError(mapProcessError));

  const runProfileCommand: AwsCliService["runProfileCommand"] = (
    profile,
    region,
    command,
    runOptions = {},
  ) => {
    if (!Array.isArray(command) || command.length === 0) {
      return Effect.fail(
        new AwsCommandError({
          message: "AWS command must be a non-empty argv array.",
          reason: "failed",
          operation: "aws",
        }),
      );
    }
    const args = [...command.map(String), "--profile", profile, "--region", region];
    const operation = command.slice(0, 2).join(" ") || "aws";
    return runner
      .runCaptured({
        command: "aws",
        args,
        env: sanitized(),
        allowNonZero: runOptions.allowNonZero ?? false,
        redact: runOptions.redact,
      })
      .pipe(Effect.mapError((error) => mapProviderProcessError(error, operation)));
  };

  const service: AwsCliService = {
    runCaptured,
    runProfileCommand,

    runInheritedSso: (args) =>
      Effect.gen(function* () {
        // Fail closed if caller attempts non-SSO inherited mode.
        try {
          assertInheritedAwsSsoAllowed("aws", args);
        } catch (cause) {
          return yield* Effect.fail(
            new AwsAuthError({
              message:
                cause instanceof Error
                  ? cause.message
                  : "Inherited AWS mode is restricted to configure sso / sso login.",
              reason: "login-failed",
              cause,
            }),
          );
        }
        return yield* runner
          .runInherited({
            command: "aws",
            args,
            env: sanitized(),
          })
          .pipe(
            Effect.mapError((error) => {
              const mapped = mapProcessError(error);
              if (mapped instanceof CancellationError) {
                return new AwsAuthError({
                  message: "AWS SSO interactive command was cancelled.",
                  reason: "login-cancelled",
                  cause: mapped,
                });
              }
              if (mapped.reason === "login-failed" || mapped.reason === "expired-session") {
                return new AwsAuthError({
                  message: mapped.message,
                  reason: "login-cancelled",
                  cause: mapped,
                });
              }
              return mapped;
            }),
          );
      }),

    listProfiles: () =>
      Effect.gen(function* () {
        const result = yield* runCaptured(["configure", "list-profiles"], { allowNonZero: true });
        if (result.exitCode !== 0) {
          // No config yet is equivalent to zero profiles.
          if ((result.stderr + result.stdout).trim() === "") return [];
          return yield* Effect.fail(
            new AwsAuthError({
              message: `aws configure list-profiles failed: ${(result.stderr || result.stdout).trim()}`,
              reason: "invalid-profile",
            }),
          );
        }
        return parseListProfiles(result.stdout);
      }),

    configureGet: (profileName, key) =>
      Effect.gen(function* () {
        const result = yield* runCaptured(["configure", "get", key, "--profile", profileName], {
          allowNonZero: true,
        });
        if (result.exitCode !== 0) return null;
        const value = result.stdout.trim();
        return value === "" ? null : value;
      }),

    configureGetSsoSession: (sessionName, key) =>
      Effect.gen(function* () {
        // aws configure get sso-session.NAME.key
        const result = yield* runCaptured(
          ["configure", "get", `sso-session.${sessionName}.${key}`],
          { allowNonZero: true },
        );
        if (result.exitCode !== 0) {
          // Fallback form used by some CLI versions.
          const alt = yield* runCaptured(
            ["configure", "get", key, "--profile", `sso-session:${sessionName}`],
            { allowNonZero: true },
          );
          if (alt.exitCode !== 0) return null;
          const altValue = alt.stdout.trim();
          return altValue === "" ? null : altValue;
        }
        const value = result.stdout.trim();
        return value === "" ? null : value;
      }),

    configureList: (profileName) =>
      Effect.gen(function* () {
        const result = yield* runCaptured(["configure", "list", "--profile", profileName], {
          allowNonZero: true,
        });
        const text = `${result.stdout}\n${result.stderr}`;
        if (result.exitCode !== 0 && isSsoSessionExpiredText(text)) {
          return yield* Effect.fail(
            new AwsAuthError({
              message: "AWS SSO session is missing or expired for this profile.",
              reason: "expired-session",
            }),
          );
        }
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new AwsAuthError({
              message: `aws configure list failed for profile "${profileName}".`,
              reason: "provenance",
            }),
          );
        }
        return text;
      }),

    getCallerIdentity: (profileName, region) =>
      Effect.gen(function* () {
        const result = yield* runCaptured(
          [
            "sts",
            "get-caller-identity",
            "--profile",
            profileName,
            "--region",
            region,
            "--output",
            "json",
          ],
          { allowNonZero: true },
        );
        const text = `${result.stdout}\n${result.stderr}`;
        if (result.exitCode !== 0) {
          if (isSsoSessionExpiredText(text)) {
            return yield* Effect.fail(
              new AwsAuthError({
                message: "AWS SSO session is missing or expired for this profile.",
                reason: "expired-session",
              }),
            );
          }
          if (isAccessDeniedText(text)) {
            return yield* Effect.fail(
              new AwsAuthError({
                message: "sts get-caller-identity returned AccessDenied.",
                reason: "access-denied",
              }),
            );
          }
          return yield* Effect.fail(
            new AwsAuthError({
              message: `sts get-caller-identity failed for profile "${profileName}".`,
              reason: "login-failed",
            }),
          );
        }
        const identity = yield* decodeStsCallerIdentity(result.stdout);
        return yield* resolveCallerFromIdentity(identity);
      }),

    verifyProfileSession: (profileName, region) =>
      Effect.gen(function* () {
        const listText = yield* service.configureList(profileName);
        yield* assertSsoProvenance(profileName, listText);
        return yield* service.getCallerIdentity(profileName, region);
      }),

    awsVersionText: () =>
      Effect.gen(function* () {
        const result = yield* runCaptured(["--version"], { allowNonZero: true });
        return `${result.stdout} ${result.stderr}`.trim();
      }),
  };

  return service;
}

export const AwsCliLive: Layer.Layer<AwsCliService, never, ProcessRunnerService> = Layer.effect(
  AwsCli,
)(
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    return makeAwsCli(runner);
  }),
);

export function AwsCliLiveWithEnv(
  parentEnv: ProcessEnvLike,
): Layer.Layer<AwsCliService, never, ProcessRunnerService> {
  return Layer.effect(AwsCli)(
    Effect.gen(function* () {
      const runner = yield* ProcessRunner;
      return makeAwsCli(runner, { parentEnv });
    }),
  );
}

export function AwsCliFake(service: Partial<AwsCliService>): Layer.Layer<AwsCliService> {
  const missing = (name: string): never => {
    throw new Error(`AwsCliFake.${name} was not configured.`);
  };
  const full: AwsCliService = {
    runCaptured: service.runCaptured ?? (() => missing("runCaptured")),
    runProfileCommand: service.runProfileCommand ?? (() => missing("runProfileCommand")),
    runInheritedSso: service.runInheritedSso ?? (() => missing("runInheritedSso")),
    listProfiles: service.listProfiles ?? (() => missing("listProfiles")),
    configureGet: service.configureGet ?? (() => missing("configureGet")),
    configureGetSsoSession:
      service.configureGetSsoSession ?? (() => missing("configureGetSsoSession")),
    configureList: service.configureList ?? (() => missing("configureList")),
    getCallerIdentity: service.getCallerIdentity ?? (() => missing("getCallerIdentity")),
    verifyProfileSession: service.verifyProfileSession ?? (() => missing("verifyProfileSession")),
    awsVersionText: service.awsVersionText ?? (() => missing("awsVersionText")),
  };
  return Layer.succeed(AwsCli)(full);
}

/** Parse aws-cli/2.x.y from --version output; require >= 2.22.0. */
export function parseAwsCliVersion(
  text: string,
): { readonly major: number; readonly minor: number; readonly patch: number } | null {
  const match = /aws-cli\/(\d+)\.(\d+)\.(\d+)/u.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isAwsCliV2_22OrNewer(text: string): boolean {
  const version = parseAwsCliVersion(text);
  if (version == null) return false;
  if (version.major !== 2) return false;
  if (version.minor > 22) return true;
  if (version.minor < 22) return false;
  return version.patch >= 0;
}

export type { ResolvedCallerContext };
