import { Effect, Schema } from "effect";

import { DatabaseError, NotFoundError } from "../errors.ts";
import { decodeDbRow, decodeDbRows } from "../http/sql-decode.ts";
import { Database, type DatabaseService, type SqlParams } from "../services/database.ts";
import { SesEventTypeValues } from "./event-schema.ts";
import type { SesEventsQuery } from "./query.ts";

const SesEventTypeSchema = Schema.Literals(SesEventTypeValues);

const SesEventRow = Schema.Struct({
  actionTaken: Schema.String,
  bounceSubType: Schema.NullOr(Schema.String),
  bounceType: Schema.NullOr(Schema.String),
  complaintFeedbackType: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  deliveryDelayType: Schema.NullOr(Schema.String),
  deliveryId: Schema.NullOr(Schema.String),
  diagnosticCode: Schema.NullOr(Schema.String),
  eventType: SesEventTypeSchema,
  feedbackId: Schema.NullOr(Schema.String),
  id: Schema.String,
  ipAddress: Schema.NullOr(Schema.String),
  linkTagsJson: Schema.NullOr(Schema.String),
  linkUrl: Schema.NullOr(Schema.String),
  mailingId: Schema.NullOr(Schema.String),
  notificationId: Schema.String,
  occurredAt: Schema.NullOr(Schema.String),
  recipientEmail: Schema.NullOr(Schema.String),
  rejectReason: Schema.NullOr(Schema.String),
  sesMessageId: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
});

type SesEventRow = typeof SesEventRow.Type;

const EventCountRow = Schema.Struct({ count: Schema.Number, eventType: SesEventTypeSchema });
const WorkerRunRow = Schema.Struct({
  claimed: Schema.Number,
  dead: Schema.Number,
  failed: Schema.Number,
  finishedAt: Schema.String,
  id: Schema.String,
  mode: Schema.String,
  released: Schema.Number,
  skippedStale: Schema.Number,
  succeeded: Schema.Number,
  workerId: Schema.String,
});
const SimulatorRunRow = Schema.Struct({
  deliveryId: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  expectedEventType: Schema.NullOr(Schema.String),
  expectedSuppressionReason: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  mailingId: Schema.NullOr(Schema.String),
  mode: Schema.String,
  purpose: Schema.String,
  recipientEmail: Schema.String,
  scenario: Schema.String,
  startedAt: Schema.String,
  status: Schema.Literals(["started", "sent", "validated", "failed", "timed_out", "ambiguous"]),
  targetBaseUrl: Schema.NullOr(Schema.String),
});

type SimulatorRunRow = typeof SimulatorRunRow.Type;

export type SesEventItem = ReturnType<typeof toSesEventItem>;
export type SesSimulatorRunItem = ReturnType<typeof toSimulatorRunItem>;
export type SesOperationsSummaryResponse = {
  readonly counts: Record<string, number>;
  readonly latestEventAt: string | null;
  readonly latestNotificationAt: string | null;
  readonly recentIssues: readonly SesEventItem[];
  readonly totals: {
    readonly bounce: number;
    readonly click: number;
    readonly complaint: number;
    readonly open: number;
  };
  readonly worker: { readonly latestRun: typeof WorkerRunRow.Type | null };
};
export type SesEventsListResponse = { readonly items: readonly SesEventItem[] };
export type SesEventDetailResponse = SesEventItem;
export type SesSimulatorRunsListResponse = { readonly items: readonly SesSimulatorRunItem[] };
export type SesSimulatorRunDetailResponse = SesSimulatorRunItem;

export function getSesOperationsSummary(): Effect.Effect<
  SesOperationsSummaryResponse,
  DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const [eventRows, latestNotification, latestEvent, recentIssues, workerRun] = yield* Effect.all(
      [
        db.all(
          "ses:summary:event-counts",
          "SELECT event_type AS eventType, count(*) AS count FROM ses_events GROUP BY event_type;",
        ),
        db.get<{ receivedAt: string }>(
          "ses:summary:latest-notification",
          "SELECT received_at AS receivedAt FROM ses_notifications ORDER BY received_at DESC LIMIT 1;",
        ),
        db.get<{ createdAt: string }>(
          "ses:summary:latest-event",
          "SELECT created_at AS createdAt FROM ses_events ORDER BY created_at DESC LIMIT 1;",
        ),
        db.all(
          "ses:summary:recent-issues",
          `SELECT ${eventSelectSql}
           FROM ses_events
           WHERE event_type IN ('Bounce', 'Complaint', 'Reject', 'DeliveryDelay', 'Rendering Failure')
           ORDER BY created_at DESC, id DESC
           LIMIT 10;`,
        ),
        db.get(
          "ses:summary:latest-worker-run",
          `SELECT id, worker_id AS workerId, mode, released, claimed, succeeded, failed, dead,
                skipped_stale AS skippedStale, finished_at AS finishedAt
         FROM worker_runs
         ORDER BY finished_at DESC, id DESC
         LIMIT 1;`,
        ),
      ],
    );

    const counts = Object.fromEntries(
      SesEventTypeValues.map((eventType) => [eventType, 0]),
    ) as Record<string, number>;
    for (const row of yield* decodeDbRows(EventCountRow, eventRows))
      counts[row.eventType] = row.count;

    return {
      counts,
      latestEventAt: latestEvent?.createdAt ?? null,
      latestNotificationAt: latestNotification?.receivedAt ?? null,
      recentIssues: (yield* decodeDbRows(SesEventRow, recentIssues)).map(toSesEventItem),
      totals: {
        bounce: counts.Bounce,
        click: counts.Click,
        complaint: counts.Complaint,
        open: counts.Open,
      },
      worker: {
        latestRun: workerRun === null ? null : yield* decodeDbRow(WorkerRunRow, workerRun),
      },
    };
  });
}

export function listSesEvents(
  query: SesEventsQuery,
): Effect.Effect<SesEventsListResponse, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const { params, where } = sesEventsWhere(query);
    const rows = yield* db.all(
      "ses:events:list",
      `SELECT ${eventSelectSql}
       FROM ses_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $limit OFFSET $offset;`,
      params,
    );
    return { items: (yield* decodeDbRows(SesEventRow, rows)).map(toSesEventItem) };
  });
}

export function getSesEventDetail(
  eventId: string,
): Effect.Effect<SesEventDetailResponse, DatabaseError | NotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get(
      "ses:events:detail",
      `SELECT ${eventSelectSql} FROM ses_events WHERE id = $eventId LIMIT 1;`,
      { eventId },
    );
    if (row === null)
      return yield* Effect.fail(new NotFoundError({ message: "SES event not found." }));
    return toSesEventItem(yield* decodeDbRow(SesEventRow, row));
  });
}

export function listSesSimulatorRuns(
  limit = 50,
): Effect.Effect<SesSimulatorRunsListResponse, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db.all(
      "ses:simulator-runs:list",
      `SELECT id, scenario, mode, purpose, mailing_id AS mailingId, delivery_id AS deliveryId,
              recipient_email AS recipientEmail, target_base_url AS targetBaseUrl, status,
              expected_event_type AS expectedEventType,
              expected_suppression_reason AS expectedSuppressionReason,
              error_message AS errorMessage, started_at AS startedAt, finished_at AS finishedAt
       FROM ses_simulator_runs
       ORDER BY started_at DESC, id DESC
       LIMIT $limit;`,
      { limit },
    );
    return { items: (yield* decodeDbRows(SimulatorRunRow, rows)).map(toSimulatorRunItem) };
  });
}

export function getSesSimulatorRunDetail(
  runId: string,
): Effect.Effect<SesSimulatorRunDetailResponse, DatabaseError | NotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get(
      "ses:simulator-runs:detail",
      `SELECT id, scenario, mode, purpose, mailing_id AS mailingId, delivery_id AS deliveryId,
              recipient_email AS recipientEmail, target_base_url AS targetBaseUrl, status,
              expected_event_type AS expectedEventType,
              expected_suppression_reason AS expectedSuppressionReason,
              error_message AS errorMessage, started_at AS startedAt, finished_at AS finishedAt
       FROM ses_simulator_runs
       WHERE id = $runId
       LIMIT 1;`,
      { runId },
    );
    if (row === null)
      return yield* Effect.fail(new NotFoundError({ message: "SES simulator run not found." }));
    return toSimulatorRunItem(yield* decodeDbRow(SimulatorRunRow, row));
  });
}

const eventSelectSql = `id, notification_id AS notificationId, event_type AS eventType,
       delivery_id AS deliveryId, mailing_id AS mailingId, ses_message_id AS sesMessageId,
       recipient_email AS recipientEmail, action_taken AS actionTaken, occurred_at AS occurredAt,
       bounce_type AS bounceType, bounce_sub_type AS bounceSubType,
       complaint_feedback_type AS complaintFeedbackType, feedback_id AS feedbackId,
       diagnostic_code AS diagnosticCode, reject_reason AS rejectReason,
       delivery_delay_type AS deliveryDelayType, link_url AS linkUrl,
       link_tags_json AS linkTagsJson, ip_address AS ipAddress, user_agent AS userAgent,
       created_at AS createdAt`;

function sesEventsWhere(query: SesEventsQuery): { params: SqlParams; where: string } {
  const clauses: string[] = [];
  const params: SqlParams = { limit: query.limit, offset: query.offset };
  if (query.eventType !== null) {
    clauses.push("event_type = $eventType");
    params.eventType = query.eventType;
  }
  if (query.mailingId !== null) {
    clauses.push("mailing_id = $mailingId");
    params.mailingId = query.mailingId;
  }
  if (query.deliveryId !== null) {
    clauses.push("delivery_id = $deliveryId");
    params.deliveryId = query.deliveryId;
  }
  if (query.email !== null) {
    clauses.push("recipient_email = $email");
    params.email = query.email.toLowerCase();
  }
  if (query.sesMessageId !== null) {
    clauses.push("ses_message_id = $sesMessageId");
    params.sesMessageId = query.sesMessageId;
  }
  return { params, where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}` };
}

function toSesEventItem(row: SesEventRow) {
  return {
    actionTaken: row.actionTaken,
    bounceSubType: row.bounceSubType,
    bounceType: row.bounceType,
    complaintFeedbackType: row.complaintFeedbackType,
    createdAt: row.createdAt,
    deliveryDelayType: row.deliveryDelayType,
    deliveryId: row.deliveryId,
    diagnosticCode: truncate(row.diagnosticCode),
    eventType: row.eventType,
    feedbackId: row.feedbackId,
    id: row.id,
    ipAddress: row.ipAddress,
    linkTags: parseLinkTags(row.linkTagsJson),
    linkUrl: row.linkUrl,
    mailingId: row.mailingId,
    notificationId: row.notificationId,
    occurredAt: row.occurredAt,
    recipientEmail: row.recipientEmail,
    rejectReason: row.rejectReason,
    sesMessageId: row.sesMessageId,
    userAgent: truncate(row.userAgent),
  };
}

function toSimulatorRunItem(row: SimulatorRunRow) {
  return {
    deliveryId: row.deliveryId,
    errorMessage: row.errorMessage,
    expectedEventType: row.expectedEventType,
    expectedSuppressionReason: row.expectedSuppressionReason,
    finishedAt: row.finishedAt,
    id: row.id,
    mailingId: row.mailingId,
    mode: row.mode,
    purpose: row.purpose,
    recipientEmail: row.recipientEmail,
    scenario: row.scenario,
    startedAt: row.startedAt,
    status: row.status,
    targetBaseUrl: row.targetBaseUrl,
  };
}

function parseLinkTags(json: string | null): Record<string, string[]> | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, string[]>;
  } catch {
    return null;
  }
}

function truncate(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= 500 ? value : `${value.slice(0, 500)}…`;
}
