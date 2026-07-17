// Shared HTTP request body helpers: JSON read, Result→Effect, plain-object
// validation, and per-route body-limit middleware with a consistent 413 envelope.
import { Effect, Result } from "effect";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { RequestValidationError } from "../errors.ts";
import { errorEnvelope } from "./respond.ts";

export function readJsonBody(request: Request): Effect.Effect<unknown, RequestValidationError> {
  return Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () => new RequestValidationError({ message: "Request body must be valid JSON." }),
  });
}

export function resultToEffect<A, E>(result: Result.Result<A, E>): Effect.Effect<A, E> {
  return Result.isFailure(result) ? Effect.fail(result.failure) : Effect.succeed(result.success);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validationFail(message: string): Result.Result<never, RequestValidationError> {
  return Result.fail(new RequestValidationError({ message }));
}

/** Factory: each route keeps its own max size; the 413 envelope is shared. */
export function jsonBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: (context: Context) =>
      context.json(errorEnvelope("request_too_large", "Request body is too large."), 413),
  });
}
