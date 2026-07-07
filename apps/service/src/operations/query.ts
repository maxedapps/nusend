import { Effect } from "effect";

import { RequestValidationError } from "../errors.ts";
import { DeliveryStatusValues, type DeliveryStatus } from "../sending/schema.ts";

export const defaultOperationsLimit = 50;
export const maxOperationsLimit = 100;
export const maxOperationsIdLength = 200;
export const maxOperationsEmailLength = 320;

export type OperationsIssueFilter = "failed_or_ambiguous";

export type DeliveriesQuery = {
  readonly email: string | null;
  readonly issue: OperationsIssueFilter | null;
  readonly limit: number;
  readonly mailingId: string | null;
  readonly sesMessageId: string | null;
  readonly status: DeliveryStatus | null;
};

export function parseDeliveriesQuery(
  params: URLSearchParams,
): Effect.Effect<DeliveriesQuery, RequestValidationError> {
  return Effect.gen(function* () {
    return {
      email: yield* optionalString(params, "email", maxOperationsEmailLength),
      issue: yield* parseIssue(params.get("issue")),
      limit: yield* parseLimit(params.get("limit")),
      mailingId: yield* optionalString(params, "mailingId", maxOperationsIdLength),
      sesMessageId: yield* optionalString(params, "sesMessageId", maxOperationsIdLength),
      status: yield* parseStatus(params.get("status")),
    };
  });
}

function parseLimit(value: string | null): Effect.Effect<number, RequestValidationError> {
  if (value === null || value === "") return Effect.succeed(defaultOperationsLimit);

  if (!/^\d+$/.test(value)) {
    return invalid(`limit must be an integer between 1 and ${maxOperationsLimit}.`);
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxOperationsLimit) {
    return invalid(`limit must be an integer between 1 and ${maxOperationsLimit}.`);
  }

  return Effect.succeed(limit);
}

function parseStatus(
  value: string | null,
): Effect.Effect<DeliveryStatus | null, RequestValidationError> {
  if (value === null || value === "") return Effect.succeed(null);
  if (isDeliveryStatus(value)) return Effect.succeed(value);

  return invalid(`status must be one of: ${DeliveryStatusValues.join(", ")}.`);
}

function parseIssue(
  value: string | null,
): Effect.Effect<OperationsIssueFilter | null, RequestValidationError> {
  if (value === null || value === "") return Effect.succeed(null);
  if (value === "failed_or_ambiguous") return Effect.succeed(value);

  return invalid("issue must be failed_or_ambiguous.");
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

function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DeliveryStatusValues as readonly string[]).includes(value);
}

function invalid(message: string): Effect.Effect<never, RequestValidationError> {
  return Effect.fail(new RequestValidationError({ message }));
}
