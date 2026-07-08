import { Effect, Result, Schema, SchemaGetter } from "effect";

import { RequestValidationError } from "../errors.ts";
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

const Email = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value: string) => normalizeValidEmail(value) ?? ""),
    encode: SchemaGetter.passthrough(),
  }),
).check(Schema.makeFilter<string>((value) => value.length > 0 || "must be a valid email address"));

const ContactEmailBody = Schema.Struct({ email: Email });

export function decodeContactEmailBody(
  value: unknown,
): Result.Result<ContactEmailInput, RequestValidationError> {
  if (!isPlainObject(value)) return fail("Request body must be a JSON object.");

  const decoded = Schema.decodeUnknownResult(ContactEmailBody)(value, { errors: "all" });
  if (Result.isFailure(decoded)) return fail(decoded.failure.message);

  return Result.succeed({ email: decoded.success.email });
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): Result.Result<never, RequestValidationError> {
  return Result.fail(new RequestValidationError({ message }));
}
