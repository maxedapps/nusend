import { Effect } from "effect";

import { RequestValidationError } from "../errors.ts";
import { SesEventTypeValues, type SesEventType } from "./event-schema.ts";

export const defaultSesEventsLimit = 50;
export const maxSesEventsLimit = 100;
export const maxSesQueryStringLength = 320;

export type SesEventsQuery = {
  readonly deliveryId: string | null;
  readonly email: string | null;
  readonly eventType: SesEventType | null;
  readonly limit: number;
  readonly mailingId: string | null;
  readonly offset: number;
  readonly sesMessageId: string | null;
};

export function parseSesEventsQuery(
  params: URLSearchParams,
): Effect.Effect<SesEventsQuery, RequestValidationError> {
  return Effect.gen(function* () {
    return {
      deliveryId: yield* optionalString(params, "deliveryId", 200),
      email: yield* optionalString(params, "email", maxSesQueryStringLength),
      eventType: yield* parseEventType(params.get("eventType")),
      limit: yield* parseLimit(params.get("limit")),
      mailingId: yield* optionalString(params, "mailingId", 200),
      offset: yield* parseOffset(params.get("offset")),
      sesMessageId: yield* optionalString(params, "sesMessageId", 200),
    };
  });
}

function parseEventType(
  value: string | null,
): Effect.Effect<SesEventType | null, RequestValidationError> {
  if (value === null || value === "") return Effect.succeed(null);
  if ((SesEventTypeValues as readonly string[]).includes(value))
    return Effect.succeed(value as SesEventType);
  return invalid(`eventType must be one of: ${SesEventTypeValues.join(", ")}.`);
}

function parseLimit(value: string | null): Effect.Effect<number, RequestValidationError> {
  if (value === null || value === "") return Effect.succeed(defaultSesEventsLimit);
  if (!/^\d+$/.test(value))
    return invalid(`limit must be an integer between 1 and ${maxSesEventsLimit}.`);
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxSesEventsLimit) {
    return invalid(`limit must be an integer between 1 and ${maxSesEventsLimit}.`);
  }
  return Effect.succeed(limit);
}

function parseOffset(value: string | null): Effect.Effect<number, RequestValidationError> {
  if (value === null || value === "") return Effect.succeed(0);
  if (!/^\d+$/.test(value)) return invalid("offset must be a non-negative integer.");
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0)
    return invalid("offset must be a non-negative integer.");
  return Effect.succeed(offset);
}

function optionalString(
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

function invalid(message: string): Effect.Effect<never, RequestValidationError> {
  return Effect.fail(new RequestValidationError({ message }));
}
