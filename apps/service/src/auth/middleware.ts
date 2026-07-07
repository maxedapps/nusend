import { Cause, Effect, Exit } from "effect";
import type { MiddlewareHandler } from "hono";

import {
  ForbiddenError,
  UnauthenticatedError,
  type AuthError,
  type DatabaseError,
} from "../errors.ts";
import { Auth, type AuthService } from "../services/auth.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { errorEnvelope, logCause, type AppRuntime } from "../http/respond.ts";
import { singleOrganizationForUserSql } from "./auth.ts";
import { hasPermissions, permissionsForRole, type PermissionSet } from "./permissions.ts";
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
  AuthService | DatabaseService
> {
  const apiKey = headers.get("x-api-key");

  if (apiKey) {
    return resolveApiKeyPrincipal(apiKey, required);
  }

  return resolveSessionPrincipal(headers, required);
}

type RequirePrincipalOptions = {
  runtime: AppRuntime;
  permissions?: PermissionSet;
};

// Thin Hono shell: runs the resolvePrincipal program and maps its typed
// failures to the exact envelopes the API has always returned.
export function requirePrincipal(options: RequirePrincipalOptions): MiddlewareHandler<AuthContext> {
  return async (context, next) => {
    const internalError = (cause: Cause.Cause<unknown>): Response => {
      logCause(cause);
      return context.json(errorEnvelope("internal_error", "Internal error."), 500);
    };

    const program = resolvePrincipal(context.req.raw.headers, options.permissions).pipe(
      Effect.map((principal) => ({ kind: "principal" as const, principal })),
      Effect.catchTags({
        AuthError: (error) =>
          Effect.succeed({ kind: "response" as const, response: internalError(Cause.fail(error)) }),
        DatabaseError: (error) =>
          Effect.succeed({ kind: "response" as const, response: internalError(Cause.fail(error)) }),
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

    if (Exit.isFailure(exit)) return internalError(exit.cause);
    if (exit.value.kind === "response") return exit.value.response;

    context.set("principal", exit.value.principal);
    await next();
  };
}

function resolveApiKeyPrincipal(
  key: string,
  required: PermissionSet | undefined,
): Effect.Effect<Principal, AuthError | ForbiddenError | UnauthenticatedError, AuthService> {
  return Effect.gen(function* () {
    const auth = yield* Auth;
    const result = yield* auth.verifyApiKey(key);

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
      organizationId: result.key.referenceId,
      permissions: result.key.permissions ?? {},
    };
  });
}

function resolveSessionPrincipal(
  headers: Headers,
  required: PermissionSet | undefined,
): Effect.Effect<
  Principal,
  AuthError | DatabaseError | ForbiddenError | UnauthenticatedError,
  AuthService | DatabaseService
> {
  return Effect.gen(function* () {
    const auth = yield* Auth;
    const db = yield* Database;

    const sessionData = yield* auth.getSession(headers);

    if (!sessionData) {
      return yield* Effect.fail(new UnauthenticatedError({ message: "Authentication required." }));
    }

    const session = sessionData.session;
    const organizationId =
      session.activeOrganizationId ?? (yield* findSingleOrganization(db, session.userId));

    if (!organizationId) {
      return yield* Effect.fail(
        new ForbiddenError({ message: "No active organization found for this session." }),
      );
    }

    const member = yield* db.get<{ role: string }>(
      "auth:find-member",
      `SELECT role
       FROM organization_members
       WHERE organization_id = $organizationId AND user_id = $userId
       LIMIT 1;`,
      { organizationId, userId: session.userId },
    );

    if (!member) {
      return yield* Effect.fail(
        new ForbiddenError({ message: "Session is not a member of the active organization." }),
      );
    }

    if (!hasPermissions(permissionsForRole(member.role), required)) {
      return yield* Effect.fail(
        new ForbiddenError({ message: "Session does not have the required permissions." }),
      );
    }

    return {
      kind: "session" as const,
      organizationId,
      role: member.role,
      userId: session.userId,
    };
  });
}

function findSingleOrganization(
  db: DatabaseService,
  userId: string,
): Effect.Effect<string | null, DatabaseError> {
  return Effect.map(
    db.all<{ organizationId: string }>("auth:single-organization", singleOrganizationForUserSql, {
      userId,
    }),
    (rows) => (rows.length === 1 ? rows[0].organizationId : null),
  );
}
