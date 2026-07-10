import { Schema } from "effect";

import { PaginationMetaSchema } from "../pagination.js";
import { PermissionSetSchema } from "../permissions.js";

export const ApiKeySchema = Schema.Struct({
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  name: Schema.String,
  permissions: PermissionSetSchema,
  preview: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
});

export const ApiKeyWithSecretSchema = Schema.Struct({
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  key: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  name: Schema.String,
  permissions: PermissionSetSchema,
  preview: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
});

export const CreateApiKeyRequestSchema = Schema.Struct({
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.String,
  permissions: PermissionSetSchema,
});

export const CreateApiKeyResponseSchema = Schema.Struct({
  apiKey: ApiKeyWithSecretSchema,
});

export const ListApiKeysResponseSchema = Schema.Struct({
  items: Schema.Array(ApiKeySchema),
  pagination: PaginationMetaSchema,
});

export const RotateApiKeyResponseSchema = Schema.Struct({
  apiKey: ApiKeyWithSecretSchema,
});

export type ApiKey = typeof ApiKeySchema.Type;
export type ApiKeyWithSecret = typeof ApiKeyWithSecretSchema.Type;
export type CreateApiKeyRequest = typeof CreateApiKeyRequestSchema.Type;
export type CreateApiKeyResponse = typeof CreateApiKeyResponseSchema.Type;
export type ListApiKeysResponse = typeof ListApiKeysResponseSchema.Type;
export type RotateApiKeyResponse = typeof RotateApiKeyResponseSchema.Type;
