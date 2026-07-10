import { Effect, Schema } from "effect";

import { DatabaseError, NotFoundError } from "../errors.ts";
import { paginationMeta, type PaginationMeta } from "../http/query.ts";
import { Database, type DatabaseService, type SqlParams } from "../services/database.ts";
import type { ContactsListQuery } from "./schema.ts";

const ContactRow = Schema.Struct({
  createdAt: Schema.String,
  email: Schema.String,
  id: Schema.String,
  updatedAt: Schema.String,
});

export type Contact = typeof ContactRow.Type;

const MembershipRow = Schema.Struct({
  listId: Schema.String,
  listName: Schema.String,
  subscribedAt: Schema.String,
  unsubscribedAt: Schema.NullOr(Schema.String),
});

type MembershipRow = typeof MembershipRow.Type;

export type ContactResponse = {
  readonly contact: Contact;
};

export type ContactsListResponse = {
  readonly items: readonly Contact[];
  readonly pagination: PaginationMeta;
};

export type ContactDetailResponse = ContactResponse & {
  readonly memberships: readonly ReturnType<typeof toMembershipItem>[];
};

export function listContacts(
  query: ContactsListQuery,
): Effect.Effect<ContactsListResponse, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const params: SqlParams = { limit: query.limit + 1, offset: query.offset };
    const where = query.email === null ? "" : "WHERE email = $email COLLATE NOCASE";
    if (query.email !== null) params.email = query.email;

    const rows = yield* db.all(
      "contacts:list",
      `SELECT id, lower(email) AS email, created_at AS createdAt, updated_at AS updatedAt
       FROM contacts
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $limit OFFSET $offset;`,
      params,
    );

    const hasMore = rows.length > query.limit;
    const items = yield* decodeRows(ContactRow, hasMore ? rows.slice(0, query.limit) : rows);
    return { items, pagination: paginationMeta(query, hasMore) };
  });
}

export function getContactDetail(
  contactId: string,
): Effect.Effect<ContactDetailResponse, DatabaseError | NotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const contact = yield* getContactRow(contactId);
    if (!contact) return yield* Effect.fail(new NotFoundError({ message: "Contact not found." }));

    const rows = yield* db.all(
      "contacts:memberships:list",
      `SELECT l.id AS listId,
              l.name AS listName,
              lm.subscribed_at AS subscribedAt,
              lm.unsubscribed_at AS unsubscribedAt
       FROM list_memberships lm
       INNER JOIN lists l ON l.id = lm.list_id
       WHERE lm.contact_id = $contactId
       ORDER BY l.name ASC, l.id ASC;`,
      { contactId },
    );

    const memberships = yield* decodeRows(MembershipRow, rows);
    return { contact, memberships: memberships.map(toMembershipItem) };
  });
}

export function getContactRow(
  contactId: string,
): Effect.Effect<Contact | null, DatabaseError, DatabaseService> {
  return Effect.flatMap(Database, (db) =>
    db
      .get(
        "contacts:get",
        `SELECT id, lower(email) AS email, created_at AS createdAt, updated_at AS updatedAt
         FROM contacts
         WHERE id = $contactId
         LIMIT 1;`,
        { contactId },
      )
      .pipe(
        Effect.flatMap((row) => (row === null ? Effect.succeed(null) : decodeRow(ContactRow, row))),
      ),
  );
}

function toMembershipItem(row: MembershipRow) {
  return {
    listId: row.listId,
    listName: row.listName,
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
