import { Data } from "effect";

export class ProcessFailedError extends Data.TaggedError("ProcessFailedError")<{
  readonly exitCode: number | null;
  readonly argv: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}> {}

export class ProcessSignalError extends Data.TaggedError("ProcessSignalError")<{
  readonly signal: string;
  readonly exitCode: number | null;
  readonly argv: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}> {}

export class ProcessStartError extends Data.TaggedError("ProcessStartError")<{
  readonly argv: readonly string[];
  readonly message: string;
  readonly cause: unknown;
}> {}

export class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

export class CancellationError extends Data.TaggedError("CancellationError")<{
  readonly message: string;
}> {}

export class TerminalError extends Data.TaggedError("TerminalError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SetupStoreErrorReason =
  | "parse"
  | "permission"
  | "version"
  | "not-found"
  | "conflict"
  | "migration"
  | "io"
  | "invalid-input";

/** Typed non-secret failures for setup state/env filesystem and schema boundaries. */
export class SetupStoreError extends Data.TaggedError("SetupStoreError")<{
  readonly message: string;
  readonly reason: SetupStoreErrorReason;
  readonly cause?: unknown;
}> {}

/** Workflow/command failures (doctor, init validation, continue guards). */
export class SetupCommandError extends Data.TaggedError("SetupCommandError")<{
  readonly message: string;
  readonly exitCode?: number;
}> {}

/** Stage or recovery command not yet ported from the legacy coordinator. */
export class NotPortedError extends Data.TaggedError("NotPortedError")<{
  readonly message: string;
  readonly stageOrCommand: string;
}> {}

export type AwsAuthErrorReason =
  | "no-suitable-profile"
  | "invalid-profile"
  | "rejected-credential-source"
  | "expired-session"
  | "login-cancelled"
  | "login-failed"
  | "configure-failed"
  | "binding-mismatch"
  | "malformed-identity"
  | "access-denied"
  | "provenance"
  | "cli-version"
  | "profile-mutation"
  | "cancelled";

/** SSO discovery, login, provenance, and binding failures (never carries tokens). */
export class AwsAuthError extends Data.TaggedError("AwsAuthError")<{
  readonly message: string;
  readonly reason: AwsAuthErrorReason;
  readonly cause?: unknown;
}> {}

export type SetupCliError =
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError
  | UsageError
  | CancellationError
  | TerminalError
  | SetupStoreError
  | SetupCommandError
  | NotPortedError
  | AwsAuthError;
