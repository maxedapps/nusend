import { Data } from "effect";

export class SesFeedbackDisabledError extends Data.TaggedError("SesFeedbackDisabledError")<{}> {}

export class SesFeedbackMalformedError extends Data.TaggedError("SesFeedbackMalformedError")<{
  readonly reason: string;
}> {}

export class SesFeedbackForbiddenError extends Data.TaggedError("SesFeedbackForbiddenError")<{
  readonly reason: string;
}> {}

export class SnsVerificationError extends Data.TaggedError("SnsVerificationError")<{
  readonly reason: string;
}> {}

export class SnsConfirmationError extends Data.TaggedError("SnsConfirmationError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export type SesFeedbackError =
  | SesFeedbackDisabledError
  | SesFeedbackMalformedError
  | SesFeedbackForbiddenError
  | SnsVerificationError
  | SnsConfirmationError;
