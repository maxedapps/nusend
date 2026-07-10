import { Schema } from "effect";

export const ErrorCodeSchema = Schema.Literals([
  "conflict",
  "empty_recipient_set",
  "forbidden",
  "idempotency_conflict",
  "internal_error",
  "invalid_request",
  "not_found",
  "recipient_limit_exceeded",
  "rate_limited",
  "request_too_large",
  "unauthenticated",
]);

export const ErrorEnvelopeSchema = Schema.Struct({
  error: Schema.Struct({
    code: ErrorCodeSchema,
    message: Schema.String,
  }),
});

export type ErrorEnvelope = typeof ErrorEnvelopeSchema.Type;
export type ErrorCode = typeof ErrorCodeSchema.Type;
