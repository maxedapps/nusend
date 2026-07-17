import { Schema } from "effect";

import { PaginationMetaSchema } from "../pagination.js";

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
  purpose: Schema.Literals(["transactional", "marketing"]),
  scheduledAt: Schema.NullOr(Schema.String),
  state: Schema.Literals(["scheduled", "sending", "completed"]),
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
    purpose: Schema.Literals(["transactional", "marketing"]),
    scheduledAt: Schema.NullOr(Schema.String),
    state: Schema.Literals(["scheduled", "sending", "completed"]),
    subject: Schema.String,
    text: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
  }),
});

export type MailingCounts = typeof MailingCountsSchema.Type;
export type MailingListItem = typeof MailingListItemSchema.Type;
export type MailingsListResponse = typeof MailingsListResponseSchema.Type;
export type MailingDetailResponse = typeof MailingDetailResponseSchema.Type;
