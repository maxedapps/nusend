import { Schema } from "effect";

import { PermissionSetSchema } from "../permissions.js";

export const MeResponseSchema = Schema.Struct({
  principal: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("session"),
      permissions: Schema.Literal("owner"),
      userId: Schema.String,
    }),
    Schema.Struct({
      apiKeyId: Schema.String,
      kind: Schema.Literal("api_key"),
      permissions: PermissionSetSchema,
      userId: Schema.String,
    }),
  ]),
});

export type MeResponse = typeof MeResponseSchema.Type;
