import {
  defaultPageLimit,
  maxPageLimit,
  type Pagination,
  type PaginationMeta,
} from "@nusend/api-contract";
import { Effect } from "effect";

import { RequestValidationError } from "../errors.ts";
export const maxRouteIdLength = 200;

// Re-export the contract pagination types so read models depend on the single
// source of truth (they import these from here).
export type { Pagination, PaginationMeta };

export function paginationMeta(pagination: Pagination, hasMore: boolean): PaginationMeta {
  return {
    limit: pagination.limit,
    nextOffset: hasMore ? pagination.offset + pagination.limit : null,
    offset: pagination.offset,
  };
}

export function parsePagination(
  params: URLSearchParams,
): Effect.Effect<Pagination, RequestValidationError> {
  return Effect.gen(function* () {
    return {
      limit: yield* parseLimit(params.get("limit")),
      offset: yield* parseOffset(params.get("offset")),
    };
  });
}

export function parseLimit(value: string | null): Effect.Effect<number, RequestValidationError> {
  if (value === null || value === "") return Effect.succeed(defaultPageLimit);
  if (!/^\d+$/.test(value))
    return invalid(`limit must be an integer between 1 and ${maxPageLimit}.`);

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPageLimit) {
    return invalid(`limit must be an integer between 1 and ${maxPageLimit}.`);
  }

  return Effect.succeed(limit);
}

export function parseOffset(value: string | null): Effect.Effect<number, RequestValidationError> {
  if (value === null || value === "") return Effect.succeed(0);
  if (!/^\d+$/.test(value)) return invalid("offset must be a non-negative integer.");

  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return invalid("offset must be a non-negative integer.");
  }

  return Effect.succeed(offset);
}

export function parseOptionalString(
  params: URLSearchParams,
  name: string,
  maxLength: number,
): Effect.Effect<string | null, RequestValidationError> {
  const value = params.get(name);
  if (value === null || value === "") return Effect.succeed(null);

  const trimmed = value.trim();
  if (trimmed.length === 0) return invalid(`${name} must not be empty.`);
  if (trimmed.length > maxLength)
    return invalid(`${name} must be at most ${maxLength} characters.`);

  return Effect.succeed(trimmed);
}

export function parseRouteId(
  value: string,
  name: string,
): Effect.Effect<string, RequestValidationError> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return invalid(`${name} must not be empty.`);
  if (trimmed.length > maxRouteIdLength)
    return invalid(`${name} must be at most ${maxRouteIdLength} characters.`);
  return Effect.succeed(trimmed);
}

export function invalid(message: string): Effect.Effect<never, RequestValidationError> {
  return Effect.fail(new RequestValidationError({ message }));
}
