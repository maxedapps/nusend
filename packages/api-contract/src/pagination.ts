import { Schema } from "effect";

export const defaultPageLimit = 50;
export const maxPageLimit = 100;

export const PaginationSchema = Schema.Struct({
  limit: Schema.Number,
  offset: Schema.Number,
});

export const PaginationMetaSchema = Schema.Struct({
  limit: Schema.Number,
  nextOffset: Schema.NullOr(Schema.Number),
  offset: Schema.Number,
});

export type Pagination = typeof PaginationSchema.Type;
export type PaginationMeta = typeof PaginationMetaSchema.Type;
