import { createHash } from "node:crypto";
import { Effect, Result } from "effect";

import {
  DatabaseError,
  IdempotencyConflictError,
  RequestValidationError,
  type EmptyRecipientSetError,
  type ListNotFoundError,
  type RecipientLimitExceededError,
} from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import type { IdGeneratorService } from "../services/ids.ts";
import type { UnsubscribeConfigService } from "../unsubscribe/config.ts";
import { createMailingRows, type CreateMailingResult } from "./create-mailing.ts";
import { decodeCreateMailingResultJson } from "./result-schema.ts";
import type { CreateMailingInput } from "./schema.ts";

export const maxIdempotencyKeyLength = 255;

type IdempotencyRow = {
  requestHash: string;
  responseJson: string;
};

export function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function createMailingIdempotent(options: {
  input: CreateMailingInput;
  idempotencyKey: string | null;
  beforeCreate?: Effect.Effect<void, RequestValidationError, UnsubscribeConfigService>;
}): Effect.Effect<
  CreateMailingResult,
  | DatabaseError
  | EmptyRecipientSetError
  | IdempotencyConflictError
  | ListNotFoundError
  | RecipientLimitExceededError
  | RequestValidationError,
  DatabaseService | IdGeneratorService | UnsubscribeConfigService
> {
  const beforeCreate = options.beforeCreate ?? Effect.void;
  if (!options.idempotencyKey) return createMailingWithoutIdempotency(options.input, beforeCreate);

  const key = options.idempotencyKey;
  const requestHash = hashCreateMailingInput(options.input);

  return createWithKey({ beforeCreate, input: options.input, key, requestHash }).pipe(
    Effect.catchTag("DatabaseError", (error) => {
      if (error.operation !== "mailing-idempotency:insert" || !isUniqueConstraintError(error)) {
        return Effect.fail(error);
      }

      return readExisting({ key, requestHash });
    }),
  );
}

function createMailingWithoutIdempotency(
  input: CreateMailingInput,
  beforeCreate: Effect.Effect<void, RequestValidationError, UnsubscribeConfigService>,
) {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* beforeCreate;
    return yield* db.transaction(createMailingRows(input));
  });
}

function createWithKey(options: {
  beforeCreate: Effect.Effect<void, RequestValidationError, UnsubscribeConfigService>;
  input: CreateMailingInput;
  key: string;
  requestHash: string;
}): Effect.Effect<
  CreateMailingResult,
  | DatabaseError
  | EmptyRecipientSetError
  | IdempotencyConflictError
  | ListNotFoundError
  | RecipientLimitExceededError
  | RequestValidationError,
  DatabaseService | IdGeneratorService | UnsubscribeConfigService
> {
  return Effect.gen(function* () {
    const db = yield* Database;

    return yield* db.transaction(
      Effect.gen(function* () {
        const existing = yield* getRow(options.key);
        if (existing) return yield* decodeExisting(options.key, existing, options.requestHash);

        yield* options.beforeCreate;
        const result = yield* createMailingRows(options.input);
        yield* db.run(
          "mailing-idempotency:insert",
          `INSERT INTO mailing_idempotency_keys (key, request_hash, mailing_id, response_json)
           VALUES ($key, $requestHash, $mailingId, $responseJson);`,
          {
            key: options.key,
            mailingId: result.mailing.id,
            requestHash: options.requestHash,
            responseJson: JSON.stringify(result),
          },
        );

        return result;
      }),
    );
  });
}

function readExisting(options: { key: string; requestHash: string }) {
  return Effect.gen(function* () {
    const existing = yield* getRow(options.key);
    if (!existing) {
      return yield* Effect.fail(new IdempotencyConflictError({ key: options.key }));
    }

    return yield* decodeExisting(options.key, existing, options.requestHash);
  });
}

function getRow(key: string): Effect.Effect<IdempotencyRow | null, DatabaseError, DatabaseService> {
  return Effect.flatMap(Database, (db) =>
    db.get<IdempotencyRow>(
      "mailing-idempotency:get",
      `SELECT request_hash AS requestHash, response_json AS responseJson
       FROM mailing_idempotency_keys
       WHERE key = $key;`,
      { key },
    ),
  );
}

function decodeExisting(
  key: string,
  row: IdempotencyRow,
  requestHash: string,
): Effect.Effect<CreateMailingResult, DatabaseError | IdempotencyConflictError> {
  if (row.requestHash !== requestHash) {
    return Effect.fail(new IdempotencyConflictError({ key }));
  }

  const decoded = decodeCreateMailingResultJson(row.responseJson);
  if (Result.isFailure(decoded)) {
    return Effect.fail(
      new DatabaseError({ cause: decoded.failure, operation: "mailing-idempotency:decode" }),
    );
  }

  return Effect.succeed(decoded.success);
}

function hashCreateMailingInput(input: CreateMailingInput): string {
  return createHash("sha256")
    .update(stableStringify(canonicalizeInput(input)))
    .digest("hex");
}

function canonicalizeInput(input: CreateMailingInput): unknown {
  return {
    html: input.html,
    listId: input.listId,
    name: input.name,
    purpose: input.purpose,
    recipients:
      input.recipients?.map((recipient) => ({
        email: recipient.email,
        vars: recipient.varsJson === null ? null : JSON.parse(recipient.varsJson),
      })) ?? null,
    scheduledAt: input.scheduledAt,
    subject: input.subject,
    text: input.text,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function isUniqueConstraintError(error: DatabaseError): boolean {
  return String(error.cause).includes("UNIQUE constraint failed");
}
