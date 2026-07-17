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

export const maxSuppressionRequestBodyBytes = 64 * 1024;
export const maxSuppressionIdLength = 200;
export const suppressionScopes = ["all", "marketing", "list"] as const;
export const suppressionReasons = ["bounce", "complaint", "manual", "unsubscribe"] as const;

export type SuppressionScope = (typeof suppressionScopes)[number];
export type SuppressionReason = (typeof suppressionReasons)[number];

export type CreateSuppressionInput = {
  readonly email: string;
  readonly listId: string | null;
  readonly scope: SuppressionScope;
};

export type SuppressionsListQuery = Pagination & {
  readonly email: string | null;
  readonly listId: string | null;
  readonly reason: SuppressionReason | null;
  readonly scope: SuppressionScope | null;
};

const ListId = Schema.NullOr(Schema.String)
  .pipe(
    Schema.decodeTo(Schema.NullOr(Schema.String), {
      decode: SchemaGetter.transform((value: string | null) =>
        value === null ? null : value.trim() || null,
      ),
      encode: SchemaGetter.passthrough(),
    }),
  )
  .check(
    Schema.makeFilter<string | null>(
      (value) => value === null || value.length <= maxSuppressionIdLength || "listId is too long",
    ),
  );

const CreateSuppressionBody = Schema.Struct({
  email: EmailSchema,
  listId: Schema.optional(ListId),
  scope: Schema.Literals(suppressionScopes),
});

export function decodeCreateSuppressionBody(
  value: unknown,
): Result.Result<CreateSuppressionInput, RequestValidationError> {
  if (!isPlainObject(value)) return validationFail("Request body must be a JSON object.");
  const decoded = Schema.decodeUnknownResult(CreateSuppressionBody)(value, { errors: "all" });
  if (Result.isFailure(decoded)) return validationFail(decoded.failure.message);

  const input = decoded.success;
  const listId = input.listId ?? null;
  if (input.scope === "list" && listId === null) {
    return validationFail("listId is required when scope is list.");
  }
  if (input.scope !== "list" && listId !== null) {
    return validationFail("listId is only allowed when scope is list.");
  }

  return Result.succeed({ email: input.email, listId, scope: input.scope });
}

export function parseSuppressionsListQuery(
  params: URLSearchParams,
): Effect.Effect<SuppressionsListQuery, RequestValidationError> {
  return Effect.gen(function* () {
    const pagination = yield* parsePagination(params);
    const rawEmail = yield* parseOptionalString(params, "email", maxEmailLength);
    const email = rawEmail === null ? null : normalizeValidEmail(rawEmail);
    if (rawEmail !== null && email === null) {
      return yield* Effect.fail(
        new RequestValidationError({ message: "email must be a valid email address." }),
      );
    }

    const scope = yield* parseEnum(params.get("scope"), "scope", suppressionScopes);
    const reason = yield* parseEnum(params.get("reason"), "reason", suppressionReasons);
    const listId = yield* parseOptionalString(params, "listId", maxSuppressionIdLength);
    if (listId !== null && scope !== null && scope !== "list") {
      return yield* Effect.fail(
        new RequestValidationError({ message: "listId can only be combined with scope=list." }),
      );
    }

    return { ...pagination, email, listId, reason, scope };
  });
}

export function parseSuppressionId(value: string): Effect.Effect<string, RequestValidationError> {
  return parseRouteId(value, "Suppression id");
}

function parseEnum<const T extends readonly string[]>(
  value: string | null,
  name: string,
  values: T,
): Effect.Effect<T[number] | null, RequestValidationError> {
  if (value === null || value === "") return Effect.succeed(null);
  const trimmed = value.trim();
  if ((values as readonly string[]).includes(trimmed)) return Effect.succeed(trimmed as T[number]);
  return Effect.fail(
    new RequestValidationError({ message: `${name} must be one of: ${values.join(", ")}.` }),
  );
}
