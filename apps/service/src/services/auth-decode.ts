import { Effect, Schema } from "effect";

import { AuthError } from "../errors.ts";
import type { ApiKeyVerification, SessionData } from "./auth.ts";

const SessionDataSchema = Schema.NullOr(
  Schema.Struct({
    session: Schema.Struct({
      userId: Schema.String,
    }),
  }),
);

const PermissionsSchema = Schema.Record(Schema.String, Schema.Array(Schema.String));

const ApiKeyVerificationSchema = Schema.Struct({
  key: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      permissions: Schema.optional(Schema.NullOr(PermissionsSchema)),
      referenceId: Schema.String,
    }),
  ),
  valid: Schema.Boolean,
});

export function decodeSessionData(value: unknown): Effect.Effect<SessionData | null, AuthError> {
  return Schema.decodeUnknownEffect(SessionDataSchema)(value).pipe(
    Effect.mapError((cause) => new AuthError({ cause, operation: "decodeSession" })),
  );
}

export function decodeApiKeyVerification(
  value: unknown,
): Effect.Effect<ApiKeyVerification, AuthError> {
  return Schema.decodeUnknownEffect(ApiKeyVerificationSchema)(value).pipe(
    Effect.map((decoded) => ({
      key: decoded.key
        ? {
            id: decoded.key.id,
            permissions: decoded.key.permissions
              ? Object.fromEntries(
                  Object.entries(decoded.key.permissions).map(([resource, actions]) => [
                    resource,
                    [...actions],
                  ]),
                )
              : null,
            referenceId: decoded.key.referenceId,
          }
        : null,
      valid: decoded.valid,
    })),
    Effect.mapError((cause) => new AuthError({ cause, operation: "decodeApiKeyVerification" })),
  );
}
