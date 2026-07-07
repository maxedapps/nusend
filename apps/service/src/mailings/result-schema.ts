import { Result, Schema } from "effect";

import { RequestValidationError } from "../errors.ts";
import type { CreateMailingResult } from "./create-mailing.ts";

export const CreateMailingResultSchema = Schema.Struct({
  counts: Schema.Struct({
    deliveries: Schema.Number,
    queued: Schema.Number,
    suppressed: Schema.Number,
  }),
  mailing: Schema.Struct({
    id: Schema.String,
    purpose: Schema.Literals(["marketing", "transactional"]),
    scheduledAt: Schema.String,
    state: Schema.Literals(["scheduled"]),
  }),
});

export function decodeCreateMailingResultJson(
  json: string,
): Result.Result<CreateMailingResult, RequestValidationError> {
  let value: unknown;

  try {
    value = JSON.parse(json);
  } catch {
    return Result.fail(
      new RequestValidationError({ message: "Stored idempotency response is invalid." }),
    );
  }

  const decoded = Schema.decodeUnknownResult(CreateMailingResultSchema)(value, { errors: "all" });

  if (Result.isFailure(decoded)) {
    return Result.fail(
      new RequestValidationError({ message: "Stored idempotency response is invalid." }),
    );
  }

  return Result.succeed(decoded.success as CreateMailingResult);
}
