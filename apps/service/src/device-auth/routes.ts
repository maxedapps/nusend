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
import { DeviceAuthorizations } from "./service.ts";

type DeviceAuthorizationRoutesOptions = {
  readonly runtime: AppRuntime;
};

export function createDeviceAuthorizationRoutes(options: DeviceAuthorizationRoutesOptions): Hono {
  const routes = new Hono();
  const jsonLimit = bodyLimit({
    maxSize: 32_768,
    onError: (context) =>
      context.json(errorEnvelope("request_too_large", "Request body is too large."), 413),
  });

  routes.post("/", jsonLimit, (context) => {
    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* decodeStartRequest(body);
      const deviceAuthorizations = yield* DeviceAuthorizations;
      return yield* deviceAuthorizations.start({
        baseUrl: new URL(context.req.url).origin,
        clientName: input.clientName,
        permissions: input.permissions,
        requesterFingerprint: lastForwardedAddress(context.req.header("x-forwarded-for")),
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
    ? Effect.fail(new RequestValidationError({ message: String(result.failure) }))
    : Effect.succeed(result.success);
}

function decodeTokenRequest(
  value: unknown,
): Effect.Effect<DeviceAuthorizationTokenRequest, RequestValidationError> {
  const result = Schema.decodeUnknownResult(DeviceAuthorizationTokenRequestSchema, {
    errors: "all",
  })(value);
  return Result.isFailure(result)
    ? Effect.fail(new RequestValidationError({ message: String(result.failure) }))
    : Effect.succeed(result.success);
}
