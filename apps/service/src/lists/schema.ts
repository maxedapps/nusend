import { Effect, Result, Schema, SchemaGetter } from "effect";

import { RequestValidationError } from "../errors.ts";
import { isPlainObject, validationFail } from "../http/body.ts";
import {
  parseOptionalString,
  parsePagination,
  parseRouteId,
  type Pagination,
} from "../http/query.ts";
import { EmailSchema, maxEmailLength, normalizeValidEmail } from "../lib/email.ts";

export const maxListRequestBodyBytes = 64 * 1024;
export const maxListImportRequestBodyBytes = 1_000_000;
export const maxListNameLength = 120;
export const maxImportContacts = 1000;

export type ListNameInput = { readonly name: string };
export type ListContactsQuery = Pagination & {
  readonly email: string | null;
  readonly status: "all" | "subscribed" | "unsubscribed";
};
export type ImportListContactsInput = {
  readonly contacts: readonly { readonly email: string }[];
};

const TrimmedName = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value: string) => value.trim()),
    encode: SchemaGetter.passthrough(),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(maxListNameLength));

const ListNameBody = Schema.Struct({ name: TrimmedName });
const ImportContactsBody = Schema.Struct({
  contacts: Schema.Array(Schema.Struct({ email: EmailSchema })).check(
    Schema.makeFilter<readonly { readonly email: string }[]>(
      (contacts) => contacts.length >= 1 || "must contain at least one contact",
    ),
    Schema.makeFilter<readonly { readonly email: string }[]>(
      (contacts) =>
        contacts.length <= maxImportContacts ||
        `must contain at most ${maxImportContacts} contacts`,
    ),
  ),
});

export function decodeListNameBody(
  value: unknown,
): Result.Result<ListNameInput, RequestValidationError> {
  if (!isPlainObject(value)) return validationFail("Request body must be a JSON object.");
  const decoded = Schema.decodeUnknownResult(ListNameBody)(value, { errors: "all" });
  return Result.isFailure(decoded)
    ? validationFail(decoded.failure.message)
    : Result.succeed({ name: decoded.success.name });
}

export function decodeImportListContactsBody(
  value: unknown,
): Result.Result<ImportListContactsInput, RequestValidationError> {
  if (!isPlainObject(value)) return validationFail("Request body must be a JSON object.");
  const decoded = Schema.decodeUnknownResult(ImportContactsBody)(value, { errors: "all" });
  if (Result.isFailure(decoded)) return validationFail(decoded.failure.message);
  return Result.succeed({ contacts: decoded.success.contacts });
}

export function parseListContactsQuery(
  params: URLSearchParams,
): Effect.Effect<ListContactsQuery, RequestValidationError> {
  return Effect.gen(function* () {
    const pagination = yield* parsePagination(params);
    const rawStatus = params.get("status")?.trim() || "subscribed";
    if (rawStatus !== "subscribed" && rawStatus !== "unsubscribed" && rawStatus !== "all") {
      return yield* Effect.fail(
        new RequestValidationError({ message: "status must be subscribed, unsubscribed, or all." }),
      );
    }

    const rawEmail = yield* parseOptionalString(params, "email", maxEmailLength);
    const email = rawEmail === null ? null : normalizeValidEmail(rawEmail);
    if (rawEmail !== null && email === null) {
      return yield* Effect.fail(
        new RequestValidationError({ message: "email must be a valid email address." }),
      );
    }

    return { ...pagination, email, status: rawStatus };
  });
}

export function parseListId(value: string): Effect.Effect<string, RequestValidationError> {
  return parseRouteId(value, "List id");
}

export function parseContactId(value: string): Effect.Effect<string, RequestValidationError> {
  return parseRouteId(value, "Contact id");
}
