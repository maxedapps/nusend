import {
  DeviceAuthorizationStartRequestSchema,
  DeviceAuthorizationTokenRequestSchema,
  type DeviceAuthorizationStartRequest,
  type DeviceAuthorizationTokenRequest,
} from "@nusend/api-contract";
import { Effect, Result, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { RequestValidationError } from "../errors.ts";
import { errorEnvelope, runRoute, type AppRuntime } from "../http/respond.ts";
import { makeAttemptLimiter, type AttemptLimiter } from "./attempt-limiter.ts";
import { DeviceAuthorizations } from "./service.ts";

type DeviceAuthorizationRoutesOptions = {
  readonly runtime: AppRuntime;
  // Canonical public origin (from BETTER_AUTH_URL) used for verification URLs
  // behind a TLS-terminating proxy; falls back to the request origin.
  readonly publicOrigin?: string;
  // Coarse request-rate limiters for the unauthenticated start endpoint (used
  // as sliding-window counters). Injectable for tests.
  readonly startRateLimiter?: AttemptLimiter;
  readonly globalStartRateLimiter?: AttemptLimiter;
};

const rateWindowMs = 15 * 60_000;
const globalRateKey = "global";

export function createDeviceAuthorizationRoutes(options: DeviceAuthorizationRoutesOptions): Hono {
  const routes = new Hono();
  const jsonLimit = bodyLimit({
    maxSize: 32_768,
    onError: (context) =>
      context.json(errorEnvelope("request_too_large", "Request body is too large."), 413),
  });
  // Unauthenticated endpoint: bound both per-source-address and total request
  // rate so a client rotating X-Forwarded-For cannot flood pending rows and
  // starve legitimate CLI logins.
  const startRateLimiter =
    options.startRateLimiter ?? makeAttemptLimiter({ max: 10, windowMs: rateWindowMs });
  const globalStartRateLimiter =
    options.globalStartRateLimiter ?? makeAttemptLimiter({ max: 60, windowMs: rateWindowMs });

  routes.post("/", jsonLimit, (context) => {
    // Trust only the proxy-appended (last) X-Forwarded-For hop.
    const address = lastForwardedAddress(context.req.header("x-forwarded-for")) ?? "direct";
    if (startRateLimiter.isLocked(address) || globalStartRateLimiter.isLocked(globalRateKey)) {
      return context.json(
        errorEnvelope("rate_limited", "Too many device authorization requests. Try again later."),
        429,
      );
    }
    startRateLimiter.recordFailure(address);
    globalStartRateLimiter.recordFailure(globalRateKey);

    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* decodeStartRequest(body);
      const deviceAuthorizations = yield* DeviceAuthorizations;
      return yield* deviceAuthorizations.start({
        baseUrl: options.publicOrigin ?? new URL(context.req.url).origin,
        clientName: input.clientName,
        permissions: input.permissions,
        requesterFingerprint: address === "direct" ? undefined : address,
      });
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result, 201));
  });

  routes.post("/token", jsonLimit, (context) => {
    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* decodeTokenRequest(body);
      const deviceAuthorizations = yield* DeviceAuthorizations;
      return yield* deviceAuthorizations.token(input.deviceCode);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  return routes;
}

function lastForwardedAddress(value: string | undefined): string | undefined {
  return value?.split(",").at(-1)?.trim();
}

function readJsonBody(request: Request): Effect.Effect<unknown, RequestValidationError> {
  return Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () => new RequestValidationError({ message: "Request body must be valid JSON." }),
  });
}

function decodeStartRequest(
  value: unknown,
): Effect.Effect<DeviceAuthorizationStartRequest, RequestValidationError> {
  const result = Schema.decodeUnknownResult(DeviceAuthorizationStartRequestSchema, {
    errors: "all",
  })(value);
  return Result.isFailure(result)
    ? invalidRequest("device-authorization:start", result.failure)
    : Effect.succeed(result.success);
}

function decodeTokenRequest(
  value: unknown,
): Effect.Effect<DeviceAuthorizationTokenRequest, RequestValidationError> {
  const result = Schema.decodeUnknownResult(DeviceAuthorizationTokenRequestSchema, {
    errors: "all",
  })(value);
  return Result.isFailure(result)
    ? invalidRequest("device-authorization:token", result.failure)
    : Effect.succeed(result.success);
}

// Returns the caller a generic message (never Effect Schema internals) while
// logging the detail server-side for diagnosability.
function invalidRequest(
  operation: string,
  failure: unknown,
): Effect.Effect<never, RequestValidationError> {
  return Effect.logWarning("request validation failed", {
    detail: String(failure),
    operation,
  }).pipe(
    Effect.andThen(
      Effect.fail(new RequestValidationError({ message: "Request body is invalid." })),
    ),
  );
}
