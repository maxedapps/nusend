import { APIError, betterAuth } from "better-auth";
import type { Database } from "bun:sqlite";

import { authSchema } from "./schema.ts";

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
    account: {
      ...authSchema.account,
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
    appName: "Nusend",
    baseURL: config.baseUrl,
    database: db,
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            throw new APIError("BAD_REQUEST", { message: "Signup is disabled." });
          },
        },
      },
    },
    secret: config.secret,
    session: authSchema.session,
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        disableImplicitSignUp: true,
        disableSignUp: true,
        prompt: "select_account",
      },
    },
    trustedOrigins: config.trustedOrigins,
    user: authSchema.user,
    verification: authSchema.verification,
  });
}
