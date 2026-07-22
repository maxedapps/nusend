import { Schema } from "effect";

import { ContactSchema } from "../contacts/schema.js";
import { PaginationMetaSchema } from "../pagination.js";

export const ListNameRequestSchema = Schema.Struct({
  name: Schema.String,
});

export const ImportListContactsRequestSchema = Schema.Struct({
  contacts: Schema.Array(
    Schema.Struct({
      email: Schema.String,
    }),
  ),
});

export const ListCountsSchema = Schema.Struct({
  subscribed: Schema.Number,
  unsubscribed: Schema.Number,
});

export const ListSchema = Schema.Struct({
  counts: ListCountsSchema,
  createdAt: Schema.String,
  id: Schema.String,
  name: Schema.String,
});

export const ListResponseSchema = Schema.Struct({
  list: ListSchema,
});

export const ListsListResponseSchema = Schema.Struct({
  items: Schema.Array(ListSchema),
  pagination: PaginationMetaSchema,
});

export const ListContactSchema = Schema.Struct({
  contact: ContactSchema,
  status: Schema.Literals(["subscribed", "unsubscribed"]),
  subscribedAt: Schema.String,
  unsubscribedAt: Schema.NullOr(Schema.String),
});

export const ListContactsResponseSchema = Schema.Struct({
  items: Schema.Array(ListContactSchema),
  pagination: PaginationMetaSchema,
});

export const ImportListContactResultSchema = Schema.Struct({
  action: Schema.Literals(["already_subscribed", "created", "resubscribed", "subscribed"]),
  contactId: Schema.String,
  email: Schema.String,
  status: Schema.Literal("subscribed"),
});

export const ImportListContactsResponseSchema = Schema.Struct({
  counts: Schema.Struct({
    accepted: Schema.Number,
    alreadySubscribed: Schema.Number,
    contactsCreated: Schema.Number,
    membershipsCreated: Schema.Number,
    resubscribed: Schema.Number,
    submitted: Schema.Number,
  }),
  items: Schema.Array(ImportListContactResultSchema),
});

export type ListNameRequest = typeof ListNameRequestSchema.Type;
export type ImportListContactsRequest = typeof ImportListContactsRequestSchema.Type;
export type ListCounts = typeof ListCountsSchema.Type;
export type List = typeof ListSchema.Type;
export type ListResponse = typeof ListResponseSchema.Type;
export type ListsListResponse = typeof ListsListResponseSchema.Type;
export type ListContact = typeof ListContactSchema.Type;
export type ListContactsResponse = typeof ListContactsResponseSchema.Type;
export type ImportListContactResult = typeof ImportListContactResultSchema.Type;
export type ImportListContactsResponse = typeof ImportListContactsResponseSchema.Type;
