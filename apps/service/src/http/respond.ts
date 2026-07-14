// HTTP boundary: frozen error envelopes, exhaustive tagged-error mapping, and
// one structured/sanitized Effect logging path for every internal failure.
import type { ErrorCode } from "@nusend/api-contract";
import { Cause, Effect, Exit, type ManagedRuntime } from "effect";
import type { Context } from "hono";

import type { ApiKeysService } from "../api-keys/service.ts";
import type { DeviceAuthorizationsService } from "../device-auth/service.ts";
import type {
  AuthError,
  ConflictError,
  DatabaseError,
  EmptyRecipientSetError,
  ForbiddenError,
  IdempotencyConflictError,
  RecipientLimitExceededError,
  RateLimitedError,
  ListNotFoundError,
  NotFoundError,
  RequestValidationError,
  UnauthenticatedError,
} from "../errors.ts";
import type { AuthService } from "../services/auth.ts";
import type { DatabaseService } from "../services/database.ts";
import type { IdGeneratorService } from "../services/ids.ts";
import {
  safeLogFields,
  safeRequestMeta,
  sanitizedLogPath,
  type SafeRequestMeta,
} from "../observability/safe-log-fields.ts";
import type { SesAdminService } from "../aws/ses-admin.ts";

export { safeLogFields, safeRequestMeta, sanitizedLogPath, type SafeRequestMeta };
import type { SnsAdminService } from "../aws/sns-admin.ts";
import type { SesOperationsConfigService } from "../ses/config.ts";
import type {
  SesOperationsDisabledError,
  SesOperationsForbiddenError,
  SesOperationsMalformedError,
  SesOperationsRetryablePayloadError,
  SnsConfirmationError,
  SnsVerificationError,
} from "../ses/errors.ts";
import type { SnsSubscriptionConfirmerService } from "../ses/sns-confirmer.ts";
import type { SnsMessageVerifierService } from "../ses/sns-verifier.ts";
import type { UnsubscribeConfigService } from "../unsubscribe/config.ts";

export type AppServices =
  | ApiKeysService
  | AuthService
  | DatabaseService
  | DeviceAuthorizationsService
  | IdGeneratorService
  | SesAdminService
  | SesOperationsConfigService
  | SnsAdminService
  | SnsMessageVerifierService
  | SnsSubscriptionConfirmerService
  | UnsubscribeConfigService;

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, unknown>;

export type RouteError =
  | AuthError
  | ConflictError
  | DatabaseError
  | EmptyRecipientSetError
  | ForbiddenError
  | IdempotencyConflictError
  | RecipientLimitExceededError
  | RateLimitedError
  | ListNotFoundError
  | NotFoundError
  | RequestValidationError
  | UnauthenticatedError;

export type WebhookRouteError =
  | DatabaseError
  | SesOperationsDisabledError
  | SesOperationsForbiddenError
  | SesOperationsMalformedError
  | SesOperationsRetryablePayloadError
  | SnsConfirmationError
  | SnsVerificationError;

export type ErrorBody = { error: { code: ErrorCode; message: string } };

export function errorEnvelope(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

export function logCause(
  cause: Cause.Cause<unknown>,
  requestMeta?: SafeRequestMeta,
): Effect.Effect<void> {
  return Effect.logError("request failed", safeLogFields(cause, requestMeta));
}

export async function respondUnexpectedError(
  context: Context,
  runtime: AppRuntime,
  error: unknown,
): Promise<Response> {
  await runtime.runPromise(logCause(Cause.die(error), safeRequestMeta(context.req.raw)));
  return context.json(errorEnvelope("internal_error", "Internal error."), 500);
}

export async function runHtmlRoute<A>(
  context: Context,
  runtime: AppRuntime,
  program: Effect.Effect<A, DatabaseError, AppServices>,
  onSuccess: (value: A) => Response,
): Promise<Response> {
  const responded = program.pipe(
    Effect.map(onSuccess),
    Effect.catchTag("DatabaseError", (error) => internalHtmlError(context, error)),
  );
  const exit = await runtime.runPromiseExit(responded);
  if (Exit.isSuccess(exit)) return exit.value;
  await runtime.runPromise(logCause(exit.cause, safeRequestMeta(context.req.raw)));
  return context.html("Internal error.", 500);
}

export async function runWebhookRoute<A>(
  context: Context,
  runtime: AppRuntime,
  program: Effect.Effect<A, WebhookRouteError, AppServices>,
  onSuccess: (value: A) => Response,
): Promise<Response> {
  const responded = program.pipe(
    Effect.map(onSuccess),
    Effect.catchTags({
      DatabaseError: (error) => emptyInternalError(context, error),
      SesOperationsDisabledError: () => Effect.succeed(new Response(null, { status: 404 })),
      SesOperationsForbiddenError: () => Effect.succeed(new Response(null, { status: 403 })),
      SesOperationsMalformedError: () => Effect.succeed(new Response(null, { status: 400 })),
      SesOperationsRetryablePayloadError: () => Effect.succeed(new Response(null, { status: 503 })),
      SnsConfirmationError: (error) => emptyInternalError(context, error),
      SnsVerificationError: () => Effect.succeed(new Response(null, { status: 403 })),
    }),
  );
  const exit = await runtime.runPromiseExit(responded);
  if (Exit.isSuccess(exit)) return exit.value;
  await runtime.runPromise(logCause(exit.cause, safeRequestMeta(context.req.raw)));
  return new Response(null, { status: 500 });
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
      ConflictError: (error) =>
        Effect.succeed(context.json(errorEnvelope("conflict", error.message), 409)),
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
      IdempotencyConflictError: () =>
        Effect.succeed(
          context.json(
            errorEnvelope(
              "idempotency_conflict",
              "Idempotency key was already used for a different request.",
            ),
            409,
          ),
        ),
      ListNotFoundError: () =>
        Effect.succeed(context.json(errorEnvelope("not_found", "List not found."), 404)),
      NotFoundError: (error) =>
        Effect.succeed(context.json(errorEnvelope("not_found", error.message), 404)),
      RateLimitedError: (error) =>
        Effect.succeed(context.json(errorEnvelope("rate_limited", error.message), 429)),
      RequestValidationError: (error) =>
        Effect.succeed(context.json(errorEnvelope("invalid_request", error.message), 400)),
      UnauthenticatedError: (error) =>
        Effect.succeed(context.json(errorEnvelope("unauthenticated", error.message), 401)),
    }),
  );
  const exit = await runtime.runPromiseExit(responded);
  if (Exit.isSuccess(exit)) return exit.value;
  await runtime.runPromise(logCause(exit.cause, safeRequestMeta(context.req.raw)));
  return context.json(errorEnvelope("internal_error", "Internal error."), 500);
}

function internalHtmlError(context: Context, error: DatabaseError) {
  return logCause(Cause.fail(error), safeRequestMeta(context.req.raw)).pipe(
    Effect.as(context.html("Internal error.", 500)),
  );
}

function emptyInternalError(context: Context, error: DatabaseError | SnsConfirmationError) {
  return logCause(Cause.fail(error), safeRequestMeta(context.req.raw)).pipe(
    Effect.as(new Response(null, { status: 500 })),
  );
}

function internalError(context: Context, error: AuthError | DatabaseError) {
  return logCause(Cause.fail(error), safeRequestMeta(context.req.raw)).pipe(
    Effect.as(context.json(errorEnvelope("internal_error", "Internal error."), 500)),
  );
}
