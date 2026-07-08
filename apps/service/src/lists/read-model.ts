import { Effect, Schema } from "effect";

import { DatabaseError, ListNotFoundError } from "../errors.ts";
import { paginationMeta, type Pagination, type PaginationMeta } from "../http/query.ts";
import { Database, type DatabaseService, type SqlParams } from "../services/database.ts";
import type { ListContactsQuery } from "./schema.ts";

const ListRow = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  name: Schema.String,
  subscribed: Schema.Number,
  unsubscribed: Schema.Number,
});

type ListRow = typeof ListRow.Type;

const ListContactRow = Schema.Struct({
  contactCreatedAt: Schema.String,
  contactEmail: Schema.String,
  contactId: Schema.String,
  contactUpdatedAt: Schema.String,
  subscribedAt: Schema.String,
  unsubscribedAt: Schema.NullOr(Schema.String),
});

type ListContactRow = typeof ListContactRow.Type;

export type ListItem = ReturnType<typeof toListItem>;

export type ListsResponse = {
  readonly items: readonly ListItem[];
  readonly pagination: PaginationMeta;
};

export type ListResponse = {
  readonly list: ListItem;
};

export type ListContactsResponse = {
  readonly items: readonly ReturnType<typeof toListContactItem>[];
  readonly pagination: PaginationMeta;
};

export function listLists(
  pagination: Pagination,
): Effect.Effect<ListsResponse, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db.all(
      "lists:list",
      listSelectSql(`GROUP BY l.id
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $limit OFFSET $offset;`),
      { limit: pagination.limit, offset: pagination.offset },
    );
    const decoded = yield* decodeRows(ListRow, rows);
    return {
      items: decoded.map(toListItem),
      pagination: paginationMeta(decoded.length, pagination),
    };
  });
}

export function getList(
  listId: string,
): Effect.Effect<ListResponse, DatabaseError | ListNotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const row = yield* getListRow(listId);
    if (!row) return yield* Effect.fail(new ListNotFoundError({ listId }));
    return { list: toListItem(row) };
  });
}

export function getListRow(
  listId: string,
): Effect.Effect<ListRow | null, DatabaseError, DatabaseService> {
  return Effect.flatMap(Database, (db) =>
    db
      .get("lists:get", listSelectSql("WHERE l.id = $listId GROUP BY l.id LIMIT 1;"), { listId })
      .pipe(
        Effect.flatMap((row) => (row === null ? Effect.succeed(null) : decodeRow(ListRow, row))),
      ),
  );
}

export function listListContacts(
  listId: string,
  query: ListContactsQuery,
): Effect.Effect<ListContactsResponse, DatabaseError | ListNotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const list = yield* getListRow(listId);
    if (!list) return yield* Effect.fail(new ListNotFoundError({ listId }));

    const params: SqlParams = { limit: query.limit, listId, offset: query.offset };
    const clauses = ["lm.list_id = $listId"];
    if (query.status === "subscribed") clauses.push("lm.unsubscribed_at IS NULL");
    if (query.status === "unsubscribed") clauses.push("lm.unsubscribed_at IS NOT NULL");
    if (query.email !== null) {
      clauses.push("c.email = $email COLLATE NOCASE");
      params.email = query.email;
    }

    const rows = yield* db.all(
      "lists:contacts:list",
      `SELECT c.id AS contactId,
              lower(c.email) AS contactEmail,
              c.created_at AS contactCreatedAt,
              c.updated_at AS contactUpdatedAt,
              lm.subscribed_at AS subscribedAt,
              lm.unsubscribed_at AS unsubscribedAt
       FROM list_memberships lm
       INNER JOIN contacts c ON c.id = lm.contact_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY c.email ASC, c.id ASC
       LIMIT $limit OFFSET $offset;`,
      params,
    );

    const decoded = yield* decodeRows(ListContactRow, rows);
    return {
      items: decoded.map(toListContactItem),
      pagination: paginationMeta(decoded.length, query),
    };
  });
}

function listSelectSql(tail: string): string {
  return `SELECT l.id AS id,
                 l.name AS name,
                 l.created_at AS createdAt,
                 COALESCE(sum(CASE WHEN lm.unsubscribed_at IS NULL AND lm.contact_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS subscribed,
                 COALESCE(sum(CASE WHEN lm.unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS unsubscribed
          FROM lists l
          LEFT JOIN list_memberships lm ON lm.list_id = l.id
          ${tail}`;
}

function toListItem(row: ListRow) {
  return {
    counts: { subscribed: row.subscribed, unsubscribed: row.unsubscribed },
    createdAt: row.createdAt,
    id: row.id,
    name: row.name,
  };
}

function toListContactItem(row: ListContactRow) {
  return {
    contact: {
      createdAt: row.contactCreatedAt,
      email: row.contactEmail,
      id: row.contactId,
      updatedAt: row.contactUpdatedAt,
    },
    status: row.unsubscribedAt === null ? ("subscribed" as const) : ("unsubscribed" as const),
    subscribedAt: row.subscribedAt,
    unsubscribedAt: row.unsubscribedAt,
  };
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
