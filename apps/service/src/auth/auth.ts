import { apiKey } from "@better-auth/api-key";
import { APIError, betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import type { Database } from "bun:sqlite";

import { apiKeySchema, authSchema, organizationSchema } from "./schema.ts";
import { authAccessControl, authRoles } from "./permissions.ts";

// API-key create/verify calls must pass this non-default config ID.
export const organizationApiKeyConfigId = "organization";

// Raw (unredacted) options — Better Auth needs plain strings. Unwrapping the
// Redacted config values happens at the Auth layer boundary.
export type AuthOptions = {
  baseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  secret: string;
  trustedOrigins: string[];
};

export function createAuth(config: AuthOptions, db: Database) {
  return betterAuth({
    appName: "Nusend",
    baseURL: config.baseUrl,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: db,
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        disableSignUp: true,
        disableImplicitSignUp: true,
        prompt: "select_account",
      },
    },
    user: authSchema.user,
    session: authSchema.session,
    account: {
      ...authSchema.account,
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
    verification: authSchema.verification,
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            throw new APIError("BAD_REQUEST", { message: "Signup is disabled." });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const organizationId = findSingleOrganizationForUser(db, String(session.userId));

            if (!organizationId) return;

            return {
              data: {
                ...session,
                activeOrganizationId: organizationId,
              },
            };
          },
        },
      },
    },
    plugins: [
      organization({
        ac: authAccessControl,
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        organizationLimit: 1,
        requireEmailVerificationOnInvitation: true,
        roles: authRoles,
        schema: organizationSchema,
      }),
      apiKey({
        configId: organizationApiKeyConfigId,
        defaultPrefix: "nusend_",
        permissions: {
          defaultPermissions: {},
        },
        rateLimit: {
          enabled: false,
        },
        references: "organization",
        schema: apiKeySchema,
      }),
    ],
  });
}

// One SQL string, two call forms: the sync helper below runs inside Better
// Auth's session-create hook (raw handle), and principal resolution runs the
// same query through the Database service (middleware.ts).
export const singleOrganizationForUserSql = `SELECT organization_id AS organizationId
 FROM organization_members
 WHERE user_id = $userId
 ORDER BY created_at ASC, id ASC
 LIMIT 2;`;

function findSingleOrganizationForUser(db: Database, userId: string): string | null {
  const rows = db.query(singleOrganizationForUserSql).all({ userId }) as {
    organizationId: string;
  }[];

  if (rows.length !== 1) return null;

  return rows[0].organizationId;
}
