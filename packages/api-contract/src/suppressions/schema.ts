import { Schema } from "effect";

import { PaginationMetaSchema } from "../pagination.js";

export const SuppressionScopeSchema = Schema.Literals(["all", "marketing", "list"]);
export const SuppressionReasonSchema = Schema.Literals([
  "bounce",
  "complaint",
  "manual",
  "unsubscribe",
]);

export const CreateSuppressionRequestSchema = Schema.Struct({
  email: Schema.String,
  listId: Schema.optional(Schema.NullOr(Schema.String)),
  scope: SuppressionScopeSchema,
});

export const SuppressionSchema = Schema.Struct({
  createdAt: Schema.String,
  email: Schema.String,
  id: Schema.String,
  listId: Schema.NullOr(Schema.String),
  reason: SuppressionReasonSchema,
  scope: SuppressionScopeSchema,
});

export const CreateSuppressionResponseSchema = Schema.Struct({
  created: Schema.Boolean,
  suppression: SuppressionSchema,
});

export const SuppressionsListResponseSchema = Schema.Struct({
  items: Schema.Array(SuppressionSchema),
  pagination: PaginationMetaSchema,
});

export type SuppressionScope = typeof SuppressionScopeSchema.Type;
export type SuppressionReason = typeof SuppressionReasonSchema.Type;
export type CreateSuppressionRequest = typeof CreateSuppressionRequestSchema.Type;
export type Suppression = typeof SuppressionSchema.Type;
export type CreateSuppressionResponse = typeof CreateSuppressionResponseSchema.Type;
export type SuppressionsListResponse = typeof SuppressionsListResponseSchema.Type;
