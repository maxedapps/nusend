import { Schema } from "effect";

import { PermissionSetSchema } from "../permissions.js";
import { ApiKeyWithSecretSchema } from "../api-keys/schema.js";

export const DeviceAuthorizationStartRequestSchema = Schema.Struct({
  clientName: Schema.String,
  permissions: PermissionSetSchema,
});

export const DeviceAuthorizationStartResponseSchema = Schema.Struct({
  deviceCode: Schema.String,
  expiresAt: Schema.String,
  intervalSeconds: Schema.Number,
  userCode: Schema.String,
  verificationUri: Schema.String,
  verificationUriComplete: Schema.optional(Schema.String),
});

export const DeviceAuthorizationTokenRequestSchema = Schema.Struct({
  deviceCode: Schema.String,
});

export const DeviceAuthorizationTokenResponseSchema = Schema.Union([
  Schema.Struct({
    apiKey: ApiKeyWithSecretSchema,
    status: Schema.Literal("approved"),
  }),
  Schema.Struct({
    intervalSeconds: Schema.Number,
    status: Schema.Literals(["authorization_pending", "slow_down"]),
  }),
  Schema.Struct({
    status: Schema.Literals(["access_denied", "expired_token", "invalid_grant"]),
  }),
]);

export type DeviceAuthorizationStartRequest = typeof DeviceAuthorizationStartRequestSchema.Type;
export type DeviceAuthorizationStartResponse = typeof DeviceAuthorizationStartResponseSchema.Type;
export type DeviceAuthorizationTokenRequest = typeof DeviceAuthorizationTokenRequestSchema.Type;
export type DeviceAuthorizationTokenResponse = typeof DeviceAuthorizationTokenResponseSchema.Type;
