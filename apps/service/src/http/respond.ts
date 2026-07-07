// HTTP boundary: the error envelope, the exhaustive tagged-error → status/code
// table, and runRoute — the only place route programs are executed.
import { Cause, Effect, Exit, Result, type ManagedRuntime } from "effect";
import type { Context } from "hono";

import type {
  AuthError,
  DatabaseError,
  EmptyRecipientSetError,
  ForbiddenError,
  RecipientLimitExceededError,
  ListNotFoundError,
  RequestValidationError,
  UnauthenticatedError,
} from "../errors.ts";
import type { AuthService } from "../services/auth.ts";
import type { DatabaseService } from "../services/database.ts";
import type { IdGeneratorService } from "../services/ids.ts";

export type AppServices = AuthService | DatabaseService | IdGeneratorService;

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, unknown>;

// The full error vocabulary a route program may fail with. runRoute handles all
// of it exhaustively, so the compiler proves every route's errors are mapped.
export type RouteError =
  | AuthError
  | DatabaseError
  | EmptyRecipientSetError
  | ForbiddenError
  | RecipientLimitExceededError
  | ListNotFoundError
  | RequestValidationError
  | UnauthenticatedError;

export type ErrorBody = { error: { code: string; message: string } };

export function errorEnvelope(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

// Sanitized: never print raw third-party causes, request payloads, SQL params, or API keys.
export function logCause(cause: Cause.Cause<unknown>): void {
  const failure = Cause.findFail(cause);

  if (Result.isSuccess(failure)) {
    console.error(summarizeFailure(failure.success.error));
    return;
  }

  console.error("Internal defect (details redacted).");
}

function summarizeFailure(error: unknown): string {
  if (isTaggedOperation(error, "AuthError")) return `Auth error during ${error.operation}.`;
  if (isTaggedOperation(error, "DatabaseError")) return `Database error during ${error.operation}.`;

  if (isTaggedMessage(error)) return `${getTag(error)}: ${error.message}`;

  return "Internal failure (details redacted).";
}

function isTaggedOperation(
  error: unknown,
  tag: "AuthError" | "DatabaseError",
): error is { operation: string } {
  return isObject(error) && getTag(error) === tag && typeof error.operation === "string";
}

function isTaggedMessage(error: unknown): error is { message: string } {
  return isObject(error) && typeof getTag(error) === "string" && typeof error.message === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getTag(value: Record<string, unknown>): unknown {
  return Reflect.get(value, "_tag");
}

export async function runRoute<A>(
  context: Context,
  runtime: AppRuntime,
  program: Effect.Effect<A, RouteError, AppServices>,
  onSuccess: (value: A) => Response,
): Promise<Response> {
  const responded = program.pipe(
    Effect.map(onSuccess),
    Effect.catchTags({
      AuthError: (error) => internalError(context, error),
      DatabaseError: (error) => internalError(context, error),
      EmptyRecipientSetError: (error) =>
        Effect.succeed(context.json(errorEnvelope("empty_recipient_set", error.reason), 422)),
      RecipientLimitExceededError: (error) =>
        Effect.succeed(
          context.json(
            errorEnvelope(
              "recipient_limit_exceeded",
              `Recipient source exceeds the maximum of ${error.limit} recipients.`,
            ),
            422,
          ),
        ),
      ForbiddenError: (error) =>
        Effect.succeed(context.json(errorEnvelope("forbidden", error.message), 403)),
      ListNotFoundError: () =>
        Effect.succeed(context.json(errorEnvelope("not_found", "List not found."), 404)),
      RequestValidationError: (error) =>
        Effect.succeed(context.json(errorEnvelope("invalid_request", error.message), 400)),
      UnauthenticatedError: (error) =>
        Effect.succeed(context.json(errorEnvelope("unauthenticated", error.message), 401)),
    }),
  );

  const exit = await runtime.runPromiseExit(responded);

  if (Exit.isSuccess(exit)) return exit.value;

  logCause(exit.cause);
  return context.json(errorEnvelope("internal_error", "Internal error."), 500);
}

function internalError(context: Context, error: AuthError | DatabaseError) {
  return Effect.sync(() => {
    logCause(Cause.fail(error));
    return context.json(errorEnvelope("internal_error", "Internal error."), 500);
  });
}
