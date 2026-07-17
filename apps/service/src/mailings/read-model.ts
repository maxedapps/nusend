import type {
  MailingCounts,
  MailingDetailResponse,
  MailingListItem,
  MailingsListResponse,
} from "@nusend/api-contract";
import { Effect, Schema } from "effect";

import { DatabaseError, NotFoundError } from "../errors.ts";
import { paginationMeta, type Pagination } from "../http/query.ts";
import { decodeDbRow, decodeDbRows } from "../http/sql-decode.ts";
import { Database, type DatabaseService, type SqlParams } from "../services/database.ts";

const MailingRow = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  listId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  purpose: Schema.Literals(["transactional", "marketing"]),
  scheduledAt: Schema.NullOr(Schema.String),
  state: Schema.Literals(["scheduled", "sending", "completed"]),
  subject: Schema.String,
  updatedAt: Schema.String,
});

const MailingDetailRow = Schema.Struct({
  ...MailingRow.fields,
  html: Schema.String,
  text: Schema.NullOr(Schema.String),
});

const CountRow = Schema.Struct({
  count: Schema.Number,
  mailingId: Schema.String,
  status: Schema.Literals(["queued", "sending", "sent", "failed", "suppressed", "ambiguous"]),
});

type MailingRow = typeof MailingRow.Type;
type CountRow = typeof CountRow.Type;

const emptyCounts = (): MailingCounts => ({
  ambiguous: 0,
  failed: 0,
  queued: 0,
  sending: 0,
  sent: 0,
  suppressed: 0,
});

export function listMailings(
  pagination: Pagination,
): Effect.Effect<MailingsListResponse, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const pageRows = yield* db.all(
      "mailings:list",
      `SELECT id,
              purpose,
              state,
              name,
              subject,
              list_id AS listId,
              scheduled_at AS scheduledAt,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM mailings
       ORDER BY created_at DESC, id DESC
       LIMIT $limit OFFSET $offset;`,
      { limit: pagination.limit + 1, offset: pagination.offset },
    );
    const hasMore = pageRows.length > pagination.limit;
    const rows = yield* decodeDbRows(
      MailingRow,
      hasMore ? pageRows.slice(0, pagination.limit) : pageRows,
    );
    const counts = yield* readCounts(
      db,
      rows.map((row) => row.id),
    );
    const items = rows.map(
      (row): MailingListItem => ({
        counts: counts.get(row.id) ?? emptyCounts(),
        createdAt: row.createdAt,
        id: row.id,
        listId: row.listId,
        name: row.name,
        purpose: row.purpose,
        scheduledAt: row.scheduledAt,
        state: row.state,
        subject: row.subject,
        updatedAt: row.updatedAt,
      }),
    );

    return {
      items,
      pagination: paginationMeta(pagination, hasMore),
    };
  });
}

export function getMailingDetail(
  id: string,
): Effect.Effect<MailingDetailResponse, DatabaseError | NotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const raw = yield* db.get(
      "mailings:get",
      `SELECT id,
              purpose,
              state,
              name,
              subject,
              html,
              text,
              list_id AS listId,
              scheduled_at AS scheduledAt,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM mailings
       WHERE id = $id
       LIMIT 1;`,
      { id },
    );
    if (raw === null) {
      return yield* Effect.fail(new NotFoundError({ message: "Mailing not found." }));
    }

    const mailing = yield* decodeDbRow(MailingDetailRow, raw);
    const counts = yield* readCounts(db, [mailing.id]);
    return {
      mailing: {
        ...mailing,
        counts: counts.get(mailing.id) ?? emptyCounts(),
      },
    };
  });
}

function readCounts(
  db: DatabaseService,
  mailingIds: readonly string[],
): Effect.Effect<ReadonlyMap<string, MailingCounts>, DatabaseError> {
  if (mailingIds.length === 0) return Effect.succeed(new Map());

  const params: SqlParams = {};
  const placeholders = mailingIds.map((mailingId, index) => {
    const name = `mailingId${index}`;
    params[name] = mailingId;
    return `$${name}`;
  });

  return Effect.gen(function* () {
    const raw = yield* db.all(
      "mailings:counts",
      `SELECT mailing_id AS mailingId, status, COUNT(*) AS count
       FROM deliveries
       WHERE mailing_id IN (${placeholders.join(", ")})
       GROUP BY mailing_id, status;`,
      params,
    );
    const rows = yield* decodeDbRows(CountRow, raw);
    const byMailing = new Map<string, MailingCounts>();

    for (const row of rows) {
      const counts = byMailing.get(row.mailingId) ?? emptyCounts();
      byMailing.set(row.mailingId, { ...counts, [row.status]: row.count });
    }

    return byMailing;
  });
}
