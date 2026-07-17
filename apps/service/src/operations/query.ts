import { Effect } from "effect";

import { RequestValidationError } from "../errors.ts";
import { invalid, parseLimit, parseOptionalString } from "../http/query.ts";
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
      email: yield* parseOptionalString(params, "email", maxOperationsEmailLength),
      issue: yield* parseIssue(params.get("issue")),
      limit: yield* parseLimit(params.get("limit"), {
        default: defaultOperationsLimit,
        max: maxOperationsLimit,
      }),
      mailingId: yield* parseOptionalString(params, "mailingId", maxOperationsIdLength),
      sesMessageId: yield* parseOptionalString(params, "sesMessageId", maxOperationsIdLength),
      status: yield* parseStatus(params.get("status")),
    };
  });
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

function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DeliveryStatusValues as readonly string[]).includes(value);
}
