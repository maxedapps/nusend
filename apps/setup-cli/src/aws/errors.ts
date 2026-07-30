import { Data } from "effect";

import type { PermissionHandoffSummary } from "./permissions.ts";

/**
 * Typed AWS CLI / provider boundary failure for workflow steps.
 * Separates auth expiry, authorization denial, throttling, timeout, and malformed JSON.
 */
export class AwsCommandError extends Data.TaggedError("AwsCommandError")<{
  readonly message: string;
  readonly reason:
    | "expired-session"
    | "access-denied"
    | "throttling"
    | "timeout"
    | "malformed-json"
    | "schema"
    | "failed"
    | "not-found"
    | "cancelled";
  readonly operation: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly cause?: unknown;
}> {}

/** Re-export permission denial for workflow catch sites (defined in permissions.ts). */
export type { PermissionHandoffSummary };

export function isRetryableAwsCommandError(error: AwsCommandError): boolean {
  return error.reason === "throttling" || error.reason === "timeout";
}

export function isAuthOrAuthorizationAwsError(error: AwsCommandError): boolean {
  return error.reason === "expired-session" || error.reason === "access-denied";
}
