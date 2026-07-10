import { Schema } from "effect";

import { PaginationMetaSchema } from "../pagination.js";

export const ContactSchema = Schema.Struct({
  createdAt: Schema.String,
  email: Schema.String,
  id: Schema.String,
  updatedAt: Schema.String,
});

export const ContactEmailRequestSchema = Schema.Struct({
  email: Schema.String,
});

export const ContactResponseSchema = Schema.Struct({
  contact: ContactSchema,
});

export const CreateContactResponseSchema = Schema.Struct({
  contact: ContactSchema,
  created: Schema.Boolean,
});

export const ContactsListResponseSchema = Schema.Struct({
  items: Schema.Array(ContactSchema),
  pagination: PaginationMetaSchema,
});

export const ContactMembershipSchema = Schema.Struct({
  listId: Schema.String,
  listName: Schema.String,
  status: Schema.Literals(["subscribed", "unsubscribed"]),
  subscribedAt: Schema.String,
  unsubscribedAt: Schema.NullOr(Schema.String),
});

export const ContactDetailResponseSchema = Schema.Struct({
  contact: ContactSchema,
  memberships: Schema.Array(ContactMembershipSchema),
});

export type Contact = typeof ContactSchema.Type;
export type ContactEmailRequest = typeof ContactEmailRequestSchema.Type;
export type ContactResponse = typeof ContactResponseSchema.Type;
export type CreateContactResponse = typeof CreateContactResponseSchema.Type;
export type ContactsListResponse = typeof ContactsListResponseSchema.Type;
export type ContactDetailResponse = typeof ContactDetailResponseSchema.Type;
export type ContactMembership = typeof ContactMembershipSchema.Type;
