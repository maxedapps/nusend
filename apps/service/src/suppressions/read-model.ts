import { Effect, Schema } from "effect";

import { DatabaseError, NotFoundError } from "../errors.ts";
import { paginationMeta, type PaginationMeta } from "../http/query.ts";
import { Database, type DatabaseService, type SqlParams } from "../services/database.ts";
import type { SuppressionsListQuery } from "./schema.ts";

const SuppressionRow = Schema.Struct({
  createdAt: Schema.String,
  email: Schema.String,
  id: Schema.String,
  listId: Schema.NullOr(Schema.String),
  reason: Schema.Literals(["bounce", "complaint", "manual", "unsubscribe"]),
  scope: Schema.Literals(["all", "marketing", "list"]),
});

export type Suppression = typeof SuppressionRow.Type;

export type SuppressionResponse = {
  readonly suppression: Suppression;
};

export type SuppressionsListResponse = {
  readonly items: readonly Suppression[];
  readonly pagination: PaginationMeta;
};

export function listSuppressions(
  query: SuppressionsListQuery,
): Effect.Effect<SuppressionsListResponse, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const params: SqlParams = { limit: query.limit + 1, offset: query.offset };
    const clauses: string[] = [];

    if (query.email !== null) {
      clauses.push("email = $email COLLATE NOCASE");
      params.email = query.email;
    }
    if (query.scope !== null) {
      clauses.push("scope = $scope");
      params.scope = query.scope;
    }
    if (query.reason !== null) {
      clauses.push("reason = $reason");
      params.reason = query.reason;
    }
    if (query.listId !== null) {
      clauses.push("list_id = $listId");
      params.listId = query.listId;
    }

    const rows = yield* db.all(
      "suppressions:list",
      `SELECT id,
              lower(email) AS email,
              scope,
              list_id AS listId,
              reason,
              created_at AS createdAt
       FROM suppressions
       ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
       ORDER BY created_at DESC, id DESC
       LIMIT $limit OFFSET $offset;`,
      params,
    );

    const hasMore = rows.length > query.limit;
    const items = yield* decodeRows(SuppressionRow, hasMore ? rows.slice(0, query.limit) : rows);
    return { items, pagination: paginationMeta(query, hasMore) };
  });
}

export function getSuppressionById(
  id: string,
): Effect.Effect<Suppression | null, DatabaseError, DatabaseService> {
  return Effect.flatMap(Database, (db) =>
    db
      .get(
        "suppressions:get",
        `SELECT id,
                lower(email) AS email,
                scope,
                list_id AS listId,
                reason,
                created_at AS createdAt
         FROM suppressions
         WHERE id = $id
         LIMIT 1;`,
        { id },
      )
      .pipe(
        Effect.flatMap((row) =>
          row === null ? Effect.succeed(null) : decodeRow(SuppressionRow, row),
        ),
      ),
  );
}

export function requireSuppressionById(
  id: string,
): Effect.Effect<Suppression, DatabaseError | NotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const suppression = yield* getSuppressionById(id);
    if (!suppression) {
      return yield* Effect.fail(new NotFoundError({ message: "Suppression not found." }));
    }
    return suppression;
  });
}

function decodeRow<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  row: unknown,
): Effect.Effect<S["Type"]> {
  return Schema.decodeUnknownEffect(schema)(row).pipe(Effect.orDie);
}

function decodeRows<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  rows: readonly unknown[],
): Effect.Effect<readonly S["Type"][]> {
  return Effect.forEach(rows, (row) => decodeRow(schema, row));
}
