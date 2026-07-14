import { Data } from "effect";

export class SesOperationsDisabledError extends Data.TaggedError(
  "SesOperationsDisabledError",
)<{}> {}

export class SesOperationsMalformedError extends Data.TaggedError("SesOperationsMalformedError")<{
  readonly reason: string;
}> {}

export class SesOperationsRetryablePayloadError extends Data.TaggedError(
  "SesOperationsRetryablePayloadError",
)<{
  readonly reason: string;
}> {}

export class SesOperationsForbiddenError extends Data.TaggedError("SesOperationsForbiddenError")<{
  readonly reason: string;
}> {}

export class SnsVerificationError extends Data.TaggedError("SnsVerificationError")<{
  readonly reason: string;
}> {}

export class SnsConfirmationError extends Data.TaggedError("SnsConfirmationError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export type SesWebhookError =
  | SesOperationsDisabledError
  | SesOperationsMalformedError
  | SesOperationsRetryablePayloadError
  | SesOperationsForbiddenError
  | SnsVerificationError
  | SnsConfirmationError;
