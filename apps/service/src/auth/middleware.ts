import type { Database } from "bun:sqlite";
import type { Context, MiddlewareHandler } from "hono";

import type { AuthInstance } from "./auth.ts";
import { findSingleOrganizationForUser, organizationApiKeyConfigId } from "./auth.ts";
import type { PermissionSet } from "./permissions.ts";
import { hasPermissions, permissionsForRole } from "./permissions.ts";
import type { Principal } from "./principal.ts";

type AuthContext = {
  Variables: {
    principal: Principal;
  };
};

type AuthMiddlewareOptions = {
  auth: AuthInstance;
  db: Database;
  permissions?: PermissionSet;
};

export function requirePrincipal(options: AuthMiddlewareOptions): MiddlewareHandler<AuthContext> {
  return async (context, next) => {
    const principal = await resolvePrincipal(context, options);

    if (!principal.ok) {
      return context.json(
        {
          error: {
            code: principal.status === 401 ? "unauthenticated" : "forbidden",
            message: principal.message,
          },
        },
        principal.status,
      );
    }

    context.set("principal", principal.principal);
    await next();
  };
}

async function resolvePrincipal(
  context: Context,
  options: AuthMiddlewareOptions,
): Promise<{ ok: true; principal: Principal } | { message: string; ok: false; status: 401 | 403 }> {
  const apiKey = context.req.header("x-api-key");

  if (apiKey) {
    return resolveApiKeyPrincipal(apiKey, options);
  }

  return resolveSessionPrincipal(context.req.raw.headers, options);
}

async function resolveApiKeyPrincipal(
  key: string,
  options: AuthMiddlewareOptions,
): Promise<{ ok: true; principal: Principal } | { message: string; ok: false; status: 401 | 403 }> {
  const result = await options.auth.api.verifyApiKey({
    body: {
      configId: organizationApiKeyConfigId,
      key,
    },
  });

  if (!result.valid || !result.key) {
    return { message: "Invalid API key.", ok: false, status: 401 };
  }

  if (!hasPermissions(result.key.permissions, options.permissions)) {
    return { message: "API key does not have the required permissions.", ok: false, status: 403 };
  }

  return {
    ok: true,
    principal: {
      apiKeyId: result.key.id,
      kind: "api_key",
      organizationId: result.key.referenceId,
      permissions: result.key.permissions ?? {},
    },
  };
}

async function resolveSessionPrincipal(
  headers: Headers,
  options: AuthMiddlewareOptions,
): Promise<{ ok: true; principal: Principal } | { message: string; ok: false; status: 401 | 403 }> {
  const sessionData = await options.auth.api.getSession({ headers });

  if (!sessionData) {
    return { message: "Authentication required.", ok: false, status: 401 };
  }

  const session = sessionData.session as { activeOrganizationId?: string | null; userId: string };
  const organizationId =
    session.activeOrganizationId ?? findSingleOrganizationForUser(options.db, session.userId);

  if (!organizationId) {
    return { message: "No active organization found for this session.", ok: false, status: 403 };
  }

  const member = findOrganizationMember(options.db, organizationId, session.userId);

  if (!member) {
    return {
      message: "Session is not a member of the active organization.",
      ok: false,
      status: 403,
    };
  }

  if (!hasPermissions(permissionsForRole(member.role), options.permissions)) {
    return { message: "Session does not have the required permissions.", ok: false, status: 403 };
  }

  return {
    ok: true,
    principal: {
      kind: "session",
      organizationId,
      role: member.role,
      userId: session.userId,
    },
  };
}

function findOrganizationMember(
  db: Database,
  organizationId: string,
  userId: string,
): { role: string } | null {
  const row = db
    .query(
      `SELECT role
       FROM organization_members
       WHERE organization_id = $organizationId AND user_id = $userId
       LIMIT 1;`,
    )
    .get({ organizationId, userId }) as { role: string } | null;

  return row;
}
