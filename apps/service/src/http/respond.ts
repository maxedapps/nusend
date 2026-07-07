// HTTP boundary: the error envelope, the exhaustive tagged-error → status/code
// table, and runRoute — the only place route programs are executed.
import { Cause, Effect, Exit, type ManagedRuntime } from "effect";
import type { Context } from "hono";

import type {
  AuthError,
  DatabaseError,
  EmptyRecipientSetError,
  ForbiddenError,
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
  | ListNotFoundError
  | RequestValidationError
  | UnauthenticatedError;

export type ErrorBody = { error: { code: string; message: string } };

export function errorEnvelope(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

// Sanitized: tagged errors carry only non-sensitive fields (operation labels,
// reasons) — never SQL params or request payloads.
export function logCause(cause: Cause.Cause<unknown>): void {
  console.error(Cause.pretty(cause));
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
