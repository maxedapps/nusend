// Better Auth backed Auth layer. This is the only place Redacted config values
// are unwrapped (betterAuth needs raw strings) and one of the allowed
// bun:sqlite import sites — see the conformance gate table in the migration
// plan (the raw handle comes from the database layer via SqliteHandle).
import type { Database as BunDatabase } from "bun:sqlite";
import { Effect, Layer, Redacted } from "effect";

import { createAuth, organizationApiKeyConfigId } from "../auth/auth.ts";
import type { AuthConfig } from "../config.ts";
import { AuthError } from "../errors.ts";
import { Auth, type ApiKeyVerification, type AuthService, type SessionData } from "./auth.ts";
import { SqliteHandle } from "./database-bun.ts";

export function AuthLive(authConfig: AuthConfig): Layer.Layer<AuthService, never, BunDatabase> {
  return Layer.effect(
    Auth,
    Effect.gen(function* () {
      const db = yield* SqliteHandle;
      const instance = createAuth(
        {
          baseUrl: authConfig.baseUrl,
          googleClientId: authConfig.googleClientId,
          googleClientSecret: Redacted.value(authConfig.googleClientSecret),
          secret: Redacted.value(authConfig.secret),
          trustedOrigins: authConfig.trustedOrigins,
        },
        db,
      );

      return {
        getSession: (headers) =>
          Effect.tryPromise({
            try: async () => {
              const result = await instance.api.getSession({ headers });
              return result ? (result as unknown as SessionData) : null;
            },
            catch: (cause) => new AuthError({ cause, operation: "getSession" }),
          }),
        handler: (request) => instance.handler(request),
        verifyApiKey: (key) =>
          Effect.tryPromise({
            try: async () => {
              const result = await instance.api.verifyApiKey({
                body: { configId: organizationApiKeyConfigId, key },
              });
              return result as unknown as ApiKeyVerification;
            },
            catch: (cause) => new AuthError({ cause, operation: "verifyApiKey" }),
          }),
      } satisfies AuthService;
    }),
  );
}
