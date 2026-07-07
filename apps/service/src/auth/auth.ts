import { apiKey } from "@better-auth/api-key";
import { APIError, betterAuth } from "better-auth";
import type { Database } from "bun:sqlite";

import { apiKeySchema, authSchema } from "./schema.ts";

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
    },
    plugins: [
      apiKey({
        defaultPrefix: "nusend_",
        permissions: {
          defaultPermissions: {},
        },
        rateLimit: {
          enabled: false,
        },
        schema: apiKeySchema,
      }),
    ],
  });
}
