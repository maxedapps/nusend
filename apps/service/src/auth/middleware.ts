import { Cause, Effect, Exit } from "effect";
import type { MiddlewareHandler } from "hono";

import { ApiKeys, type ApiKeysService } from "../api-keys/service.ts";
import { DatabaseError, ForbiddenError, UnauthenticatedError, type AuthError } from "../errors.ts";
import { errorEnvelope, logCause, safeRequestMeta, type AppRuntime } from "../http/respond.ts";
import { Auth, type AuthService } from "../services/auth.ts";
import { hasPermissions, type PermissionSet } from "./permissions.ts";
import type { Principal } from "./principal.ts";

type AuthContext = {
  Variables: {
    principal: Principal;
  };
};

export function resolvePrincipal(
  headers: Headers,
  required?: PermissionSet,
): Effect.Effect<
  Principal,
  AuthError | DatabaseError | ForbiddenError | UnauthenticatedError,
  AuthService | ApiKeysService
> {
  const apiKey = headers.get("x-api-key");

  if (apiKey) {
    return resolveApiKeyPrincipal(apiKey, required);
  }

  return resolveSessionPrincipal(headers);
}

type RequirePrincipalOptions = {
  runtime: AppRuntime;
  permissions?: PermissionSet;
};

// Thin Hono shell: runs the resolvePrincipal program and maps its typed
// failures to the exact envelopes the API has always returned.
export function requirePrincipal(options: RequirePrincipalOptions): MiddlewareHandler<AuthContext> {
  return async (context, next) => {
    const internalError = (cause: Cause.Cause<unknown>) =>
      logCause(cause, safeRequestMeta(context.req.raw)).pipe(
        Effect.as(context.json(errorEnvelope("internal_error", "Internal error."), 500)),
      );

    const program = resolvePrincipal(context.req.raw.headers, options.permissions).pipe(
      Effect.map((principal) => ({ kind: "principal" as const, principal })),
      Effect.catchTags({
        AuthError: (error) =>
          internalError(Cause.fail(error)).pipe(
            Effect.map((response) => ({ kind: "response" as const, response })),
          ),
        DatabaseError: (error) =>
          internalError(Cause.fail(error)).pipe(
            Effect.map((response) => ({ kind: "response" as const, response })),
          ),
        ForbiddenError: (error) =>
          Effect.succeed({
            kind: "response" as const,
            response: context.json(errorEnvelope("forbidden", error.message), 403),
          }),
        UnauthenticatedError: (error) =>
          Effect.succeed({
            kind: "response" as const,
            response: context.json(errorEnvelope("unauthenticated", error.message), 401),
          }),
      }),
    );

    const exit = await options.runtime.runPromiseExit(program);

    if (Exit.isFailure(exit)) {
      return await options.runtime.runPromise(internalError(exit.cause));
    }
    if (exit.value.kind === "response") return exit.value.response;

    context.set("principal", exit.value.principal);
    await next();
  };
}

function resolveApiKeyPrincipal(
  key: string,
  required: PermissionSet | undefined,
): Effect.Effect<Principal, DatabaseError | ForbiddenError | UnauthenticatedError, ApiKeysService> {
  return Effect.gen(function* () {
    const apiKeys = yield* ApiKeys;
    const result = yield* apiKeys.verify(key);

    if (!result.valid || !result.key) {
      return yield* Effect.fail(new UnauthenticatedError({ message: "Invalid API key." }));
    }

    if (!hasPermissions(result.key.permissions, required)) {
      return yield* Effect.fail(
        new ForbiddenError({ message: "API key does not have the required permissions." }),
      );
    }

    return {
      apiKeyId: result.key.id,
      kind: "api_key" as const,
      permissions: result.key.permissions ?? {},
      userId: result.key.userId,
    };
  });
}

function resolveSessionPrincipal(
  headers: Headers,
): Effect.Effect<Principal, AuthError | UnauthenticatedError, AuthService> {
  return Effect.gen(function* () {
    const auth = yield* Auth;
    const sessionData = yield* auth.getSession(headers);

    // Single-user/self-hosted model: any valid session is the instance owner and
    // therefore bypasses per-route permission checks. API keys remain permission-scoped.
    if (!sessionData) {
      return yield* Effect.fail(new UnauthenticatedError({ message: "Authentication required." }));
    }

    return {
      kind: "session" as const,
      userId: sessionData.session.userId,
    };
  });
}
