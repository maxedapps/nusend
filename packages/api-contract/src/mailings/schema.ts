import { Schema } from "effect";

import { PaginationMetaSchema } from "../pagination.js";

export const MailingPurposeSchema = Schema.Literals(["transactional", "marketing"]);
export const MailingStateSchema = Schema.Literals(["scheduled", "sending", "completed"]);

export const CreateMailingRecipientSchema = Schema.Struct({
  email: Schema.String,
  vars: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

// Structural wire contract only. The service remains authoritative for raw
// recipient-source presence, normalization, limits, and business validation.
export const CreateMailingRequestSchema = Schema.Struct({
  html: Schema.String,
  listId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  purpose: MailingPurposeSchema,
  recipients: Schema.optional(Schema.Array(CreateMailingRecipientSchema)),
  scheduledAt: Schema.optional(Schema.NullOr(Schema.String)),
  subject: Schema.String,
  text: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CreateMailingResponseSchema = Schema.Struct({
  counts: Schema.Struct({
    deliveries: Schema.Number,
    queued: Schema.Number,
    suppressed: Schema.Number,
  }),
  mailing: Schema.Struct({
    id: Schema.String,
    purpose: MailingPurposeSchema,
    scheduledAt: Schema.String,
    state: Schema.Literal("scheduled"),
  }),
});

export const MailingCountsSchema = Schema.Struct({
  ambiguous: Schema.Number,
  failed: Schema.Number,
  queued: Schema.Number,
  sending: Schema.Number,
  sent: Schema.Number,
  suppressed: Schema.Number,
});

export const MailingListItemSchema = Schema.Struct({
  counts: MailingCountsSchema,
  createdAt: Schema.String,
  id: Schema.String,
  listId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  purpose: MailingPurposeSchema,
  scheduledAt: Schema.NullOr(Schema.String),
  state: MailingStateSchema,
  subject: Schema.String,
  updatedAt: Schema.String,
});

export const MailingsListResponseSchema = Schema.Struct({
  items: Schema.Array(MailingListItemSchema),
  pagination: PaginationMetaSchema,
});

export const MailingDetailResponseSchema = Schema.Struct({
  mailing: Schema.Struct({
    counts: MailingCountsSchema,
    createdAt: Schema.String,
    html: Schema.String,
    id: Schema.String,
    listId: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
    purpose: MailingPurposeSchema,
    scheduledAt: Schema.NullOr(Schema.String),
    state: MailingStateSchema,
    subject: Schema.String,
    text: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
  }),
});

export type MailingPurpose = typeof MailingPurposeSchema.Type;
export type MailingState = typeof MailingStateSchema.Type;
export type CreateMailingRecipient = typeof CreateMailingRecipientSchema.Type;
export type CreateMailingRequest = typeof CreateMailingRequestSchema.Type;
export type CreateMailingResponse = typeof CreateMailingResponseSchema.Type;
export type MailingCounts = typeof MailingCountsSchema.Type;
export type MailingListItem = typeof MailingListItemSchema.Type;
export type MailingsListResponse = typeof MailingsListResponseSchema.Type;
export type MailingDetailResponse = typeof MailingDetailResponseSchema.Type;
