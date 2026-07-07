import { Effect, Result } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { requirePrincipal } from "../auth/middleware.ts";
import { RequestValidationError } from "../errors.ts";
import { errorEnvelope, runRoute, type AppRuntime } from "../http/respond.ts";
import {
  createMailingIdempotent,
  maxIdempotencyKeyLength,
  normalizeIdempotencyKey,
} from "./idempotency.ts";
import {
  decodeCreateMailingRequest,
  maxMailingRequestBodyBytes,
  type CreateMailingInput,
} from "./schema.ts";

type MailingsRoutesOptions = {
  runtime: AppRuntime;
};

export function createMailingsRoutes(options: MailingsRoutesOptions): Hono {
  const routes = new Hono();

  routes.post(
    "/",
    bodyLimit({
      maxSize: maxMailingRequestBodyBytes,
      onError: (context) =>
        context.json(errorEnvelope("request_too_large", "Request body is too large."), 413),
    }),
    requirePrincipal({ permissions: { mailings: ["create"] }, runtime: options.runtime }),
    (context) => {
      const program = Effect.gen(function* () {
        const body = yield* Effect.tryPromise({
          try: () => context.req.raw.json() as Promise<unknown>,
          catch: () => new RequestValidationError({ message: "Request body must be valid JSON." }),
        });

        const input: CreateMailingInput = yield* decodeToEffect(decodeCreateMailingRequest(body));
        const idempotencyKey = yield* normalizeRouteIdempotencyKey(
          context.req.header("Idempotency-Key"),
        );

        return yield* createMailingIdempotent({ idempotencyKey, input });
      });

      return runRoute(context, options.runtime, program, (result) => context.json(result, 201));
    },
  );

  return routes;
}

function normalizeRouteIdempotencyKey(
  value: string | null | undefined,
): Effect.Effect<string | null, RequestValidationError> {
  const key = normalizeIdempotencyKey(value);
  if (key !== null && key.length > maxIdempotencyKeyLength) {
    return Effect.fail(
      new RequestValidationError({
        message: `Idempotency-Key must be at most ${maxIdempotencyKeyLength} characters.`,
      }),
    );
  }

  return Effect.succeed(key);
}

function decodeToEffect(
  decoded: Result.Result<CreateMailingInput, RequestValidationError>,
): Effect.Effect<CreateMailingInput, RequestValidationError> {
  return Result.isFailure(decoded) ? Effect.fail(decoded.failure) : Effect.succeed(decoded.success);
}
