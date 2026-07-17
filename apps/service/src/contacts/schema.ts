import { ContactEmailRequestSchema } from "@nusend/api-contract";
import { Effect, Result, Schema } from "effect";

import { RequestValidationError } from "../errors.ts";
import { isPlainObject, validationFail } from "../http/body.ts";
import {
  parseOptionalString,
  parsePagination,
  parseRouteId,
  type Pagination,
} from "../http/query.ts";
import { maxEmailLength, normalizeValidEmail } from "../lib/email.ts";

export const maxContactRequestBodyBytes = 64 * 1024;

export type ContactEmailInput = {
  readonly email: string;
};

export type ContactsListQuery = Pagination & {
  readonly email: string | null;
};

export function decodeContactEmailBody(
  value: unknown,
): Result.Result<ContactEmailInput, RequestValidationError> {
  if (!isPlainObject(value)) return validationFail("Request body must be a JSON object.");

  const decoded = Schema.decodeUnknownResult(ContactEmailRequestSchema)(value, { errors: "all" });
  if (Result.isFailure(decoded)) return validationFail(decoded.failure.message);

  const email = normalizeValidEmail(decoded.success.email);
  return email === null
    ? validationFail("email must be a valid email address.")
    : Result.succeed({ email });
}

export function parseContactsListQuery(
  params: URLSearchParams,
): Effect.Effect<ContactsListQuery, RequestValidationError> {
  return Effect.gen(function* () {
    const pagination = yield* parsePagination(params);
    const rawEmail = yield* parseOptionalString(params, "email", maxEmailLength);
    const email = rawEmail === null ? null : normalizeValidEmail(rawEmail);
    if (rawEmail !== null && email === null) {
      return yield* Effect.fail(
        new RequestValidationError({ message: "email must be a valid email address." }),
      );
    }

    return { ...pagination, email };
  });
}

export function parseContactId(value: string): Effect.Effect<string, RequestValidationError> {
  return parseRouteId(value, "Contact id");
}
