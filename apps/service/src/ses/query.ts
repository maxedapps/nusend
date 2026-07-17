import { Effect } from "effect";

import { RequestValidationError } from "../errors.ts";
import { invalid, parseLimit, parseOffset, parseOptionalString } from "../http/query.ts";
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
      deliveryId: yield* parseOptionalString(params, "deliveryId", 200),
      email: yield* parseOptionalString(params, "email", maxSesQueryStringLength),
      eventType: yield* parseEventType(params.get("eventType")),
      limit: yield* parseLimit(params.get("limit"), {
        default: defaultSesEventsLimit,
        max: maxSesEventsLimit,
      }),
      mailingId: yield* parseOptionalString(params, "mailingId", 200),
      offset: yield* parseOffset(params.get("offset")),
      sesMessageId: yield* parseOptionalString(params, "sesMessageId", 200),
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
