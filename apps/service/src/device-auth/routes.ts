import {
  DeviceAuthorizationStartRequestSchema,
  DeviceAuthorizationTokenRequestSchema,
  type DeviceAuthorizationStartRequest,
  type DeviceAuthorizationTokenRequest,
} from "@nusend/api-contract";
import { Effect, Result, Schema } from "effect";
import { Hono } from "hono";

import { RequestValidationError } from "../errors.ts";
import { jsonBodyLimit, readJsonBody } from "../http/body.ts";
import { errorEnvelope, runRoute, type AppRuntime } from "../http/respond.ts";
import { makeAttemptLimiter, type AttemptLimiter } from "./attempt-limiter.ts";
import { DeviceAuthorizations } from "./service.ts";

type DeviceAuthorizationRoutesOptions = {
  readonly runtime: AppRuntime;
  // Canonical public origin (from BETTER_AUTH_URL) used for verification URLs
  // behind a TLS-terminating proxy; falls back to the request origin.
  readonly publicOrigin?: string;
  // Process-local sliding-window limiters. Injectable for deterministic tests.
  readonly startRateLimiter?: AttemptLimiter;
  readonly globalStartRateLimiter?: AttemptLimiter;
  readonly tokenRateLimiter?: AttemptLimiter;
  readonly globalTokenRateLimiter?: AttemptLimiter;
};

const startRateWindowMs = 15 * 60_000;
const tokenRateWindowMs = 60_000;
const globalRateKey = "global";
const rateLimitMessage = "Too many device authorization requests. Try again later.";

export function makeDefaultDeviceAuthorizationRouteLimiters(now?: () => number): {
  readonly globalStart: AttemptLimiter;
  readonly globalToken: AttemptLimiter;
  readonly startSource: AttemptLimiter;
  readonly tokenSource: AttemptLimiter;
} {
  const clock = now ? { now } : {};
  return {
    globalStart: makeAttemptLimiter({
      max: 60,
      maxEntries: 1,
      windowMs: startRateWindowMs,
      ...clock,
    }),
    globalToken: makeAttemptLimiter({
      max: 600,
      maxEntries: 1,
      windowMs: tokenRateWindowMs,
      ...clock,
    }),
    startSource: makeAttemptLimiter({
      max: 10,
      maxEntries: 128,
      windowMs: startRateWindowMs,
      ...clock,
    }),
    tokenSource: makeAttemptLimiter({
      max: 120,
      maxEntries: 1_024,
      windowMs: tokenRateWindowMs,
      ...clock,
    }),
  };
}

export function createDeviceAuthorizationRoutes(options: DeviceAuthorizationRoutesOptions): Hono {
  const routes = new Hono();
  const jsonLimit = jsonBodyLimit(32_768);
  // Unauthenticated endpoint: bound both per-source-address and total request
  // rate so a client rotating X-Forwarded-For cannot flood pending rows and
  // starve legitimate CLI logins.
  const defaults = makeDefaultDeviceAuthorizationRouteLimiters();
  const startRateLimiter = options.startRateLimiter ?? defaults.startSource;
  const globalStartRateLimiter = options.globalStartRateLimiter ?? defaults.globalStart;
  const tokenRateLimiter = options.tokenRateLimiter ?? defaults.tokenSource;
  const globalTokenRateLimiter = options.globalTokenRateLimiter ?? defaults.globalToken;

  routes.post("/", jsonLimit, (context) => {
    // Trust only the proxy-appended (last) X-Forwarded-For hop.
    const address = lastForwardedAddress(context.req.header("x-forwarded-for")) ?? "direct";
    const globalDecision = globalStartRateLimiter.attempt(globalRateKey);
    if (globalDecision.kind === "Limited") {
      context.header("Retry-After", retryAfterSeconds(globalDecision.retryAfterMs));
      return context.json(errorEnvelope("rate_limited", rateLimitMessage), 429);
    }
    const sourceDecision = startRateLimiter.attempt(address);
    if (sourceDecision.kind === "Limited") {
      context.header("Retry-After", retryAfterSeconds(sourceDecision.retryAfterMs));
      return context.json(errorEnvelope("rate_limited", rateLimitMessage), 429);
    }

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
    const address = lastForwardedAddress(context.req.header("x-forwarded-for")) ?? "direct";
    const globalDecision = globalTokenRateLimiter.attempt(globalRateKey);
    if (globalDecision.kind === "Limited") {
      context.header("Retry-After", retryAfterSeconds(globalDecision.retryAfterMs));
      return context.json(errorEnvelope("rate_limited", rateLimitMessage), 429);
    }
    const sourceDecision = tokenRateLimiter.attempt(address);
    if (sourceDecision.kind === "Limited") {
      context.header("Retry-After", retryAfterSeconds(sourceDecision.retryAfterMs));
      return context.json(errorEnvelope("rate_limited", rateLimitMessage), 429);
    }

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

function retryAfterSeconds(retryAfterMs: number): string {
  return String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
}

function decodeStartRequest(
  value: unknown,
): Effect.Effect<DeviceAuthorizationStartRequest, RequestValidationError> {
  const result = Schema.decodeUnknownResult(DeviceAuthorizationStartRequestSchema)(value, {
    errors: "all",
  });
  return Result.isFailure(result)
    ? invalidRequest("device-authorization:start", result.failure)
    : Effect.succeed(result.success);
}

function decodeTokenRequest(
  value: unknown,
): Effect.Effect<DeviceAuthorizationTokenRequest, RequestValidationError> {
  const result = Schema.decodeUnknownResult(DeviceAuthorizationTokenRequestSchema)(value, {
    errors: "all",
  });
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
