import { Effect } from "effect";

import type { DatabaseError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import type { DeliveryContext, DeliveryStatus, StartedAttempt } from "./schema.ts";

const maxStoredErrorLength = 2000;

export type StartAttemptResult =
  | { readonly kind: "Started"; readonly attempt: StartedAttempt }
  | { readonly kind: "Skipped"; readonly status: DeliveryStatus | null };

export function startSendAttempt(
  context: DeliveryContext,
): Effect.Effect<StartAttemptResult, DatabaseError, DatabaseService | IdGeneratorService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;

    return yield* db.transaction(
      Effect.gen(function* () {
        const now = yield* currentIso;
        const claimed = yield* db.get<{ id: string }>(
          "sending:delivery:mark-sending",
          `UPDATE deliveries
           SET status = 'sending', last_error = NULL, updated_at = $now
           WHERE id = $deliveryId AND status = 'queued'
           RETURNING id;`,
          { deliveryId: context.delivery.id, now },
        );

        if (!claimed) {
          const row = yield* db.get<{ status: DeliveryStatus }>(
            "sending:delivery:reload-status",
            "SELECT status FROM deliveries WHERE id = $deliveryId;",
            { deliveryId: context.delivery.id },
          );
          return { kind: "Skipped" as const, status: row?.status ?? null };
        }

        const count = yield* db.get<{ count: number }>(
          "sending:attempt:count",
          "SELECT count(*) AS count FROM send_attempts WHERE delivery_id = $deliveryId;",
          { deliveryId: context.delivery.id },
        );
        const attemptNo = (count?.count ?? 0) + 1;
        const attemptId = yield* ids.next;

        yield* db.run(
          "sending:attempt:insert",
          `INSERT INTO send_attempts (
             id, delivery_id, job_id, attempt_no, status, started_at
           ) VALUES (
             $id, $deliveryId, $jobId, $attemptNo, 'started', $now
           );`,
          {
            attemptNo,
            deliveryId: context.delivery.id,
            id: attemptId,
            jobId: context.job.id,
            now,
          },
        );

        return { kind: "Started" as const, attempt: { attemptId, attemptNo } };
      }),
    );
  });
}

export function recordSendSuccess(options: {
  attemptId: string;
  deliveryId: string;
  messageId: string;
}): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;

    yield* db.transaction(
      Effect.gen(function* () {
        const updatedAttempt = yield* db.get<{ id: string }>(
          "sending:attempt:succeed",
          `UPDATE send_attempts
           SET status = 'succeeded', ses_message_id = $messageId, finished_at = $now
           WHERE id = $attemptId
             AND delivery_id = $deliveryId
             AND status = 'started'
             AND EXISTS (
               SELECT 1 FROM deliveries WHERE id = $deliveryId AND status = 'sending'
             )
           RETURNING id;`,
          {
            attemptId: options.attemptId,
            deliveryId: options.deliveryId,
            messageId: options.messageId,
            now,
          },
        );
        if (!updatedAttempt) return;

        yield* db.get<{ id: string }>(
          "sending:delivery:succeed",
          `UPDATE deliveries
           SET status = 'sent', ses_message_id = $messageId, last_error = NULL, updated_at = $now
           WHERE id = $deliveryId AND status = 'sending'
           RETURNING id;`,
          { deliveryId: options.deliveryId, messageId: options.messageId, now },
        );
      }),
    );
  });
}

export function recordPermanentFailure(options: {
  attemptId: string;
  deliveryId: string;
  errorMessage: string;
  status?: "failed" | "suppressed";
}): Effect.Effect<void, DatabaseError, DatabaseService> {
  return recordFailure({
    ...options,
    attemptStatus: "failed",
    deliveryStatus: options.status ?? "failed",
  });
}

export function recordRetryableFailure(options: {
  attemptId: string;
  deliveryId: string;
  errorMessage: string;
}): Effect.Effect<void, DatabaseError, DatabaseService> {
  return recordFailure({ ...options, attemptStatus: "failed", deliveryStatus: "queued" });
}

export function recordAmbiguousFailure(options: {
  attemptId: string;
  deliveryId: string;
  errorMessage: string;
}): Effect.Effect<void, DatabaseError, DatabaseService> {
  return recordFailure({ ...options, attemptStatus: "ambiguous", deliveryStatus: "failed" });
}

export function recordStaleSendingAsAmbiguous(options: {
  deliveryId: string;
  errorMessage: string;
}): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;
    const errorMessage = truncate(options.errorMessage);

    yield* db.transaction(
      Effect.gen(function* () {
        const attempt = yield* db.get<{ id: string }>(
          "sending:attempt:latest-started",
          `SELECT id
           FROM send_attempts
           WHERE delivery_id = $deliveryId AND status = 'started'
           ORDER BY attempt_no DESC
           LIMIT 1;`,
          { deliveryId: options.deliveryId },
        );

        if (!attempt) return;

        const updatedAttempt = yield* db.get<{ id: string }>(
          "sending:attempt:stale-ambiguous",
          `UPDATE send_attempts
           SET status = 'ambiguous', error_message = $errorMessage, finished_at = $now
           WHERE id = $attemptId
             AND delivery_id = $deliveryId
             AND status = 'started'
             AND EXISTS (
               SELECT 1 FROM deliveries WHERE id = $deliveryId AND status = 'sending'
             )
           RETURNING id;`,
          { attemptId: attempt.id, deliveryId: options.deliveryId, errorMessage, now },
        );
        if (!updatedAttempt) return;

        yield* db.get<{ id: string }>(
          "sending:delivery:stale-ambiguous",
          `UPDATE deliveries
           SET status = 'failed', last_error = $errorMessage, updated_at = $now
           WHERE id = $deliveryId AND status = 'sending'
           RETURNING id;`,
          { deliveryId: options.deliveryId, errorMessage, now },
        );
      }),
    );
  });
}

function recordFailure(options: {
  attemptId: string;
  attemptStatus: "ambiguous" | "failed";
  deliveryId: string;
  deliveryStatus: "failed" | "queued" | "suppressed";
  errorMessage: string;
}): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;
    const errorMessage = truncate(options.errorMessage);

    yield* db.transaction(
      Effect.gen(function* () {
        const updatedAttempt = yield* db.get<{ id: string }>(
          "sending:attempt:fail",
          `UPDATE send_attempts
           SET status = $attemptStatus, error_message = $errorMessage, finished_at = $now
           WHERE id = $attemptId
             AND delivery_id = $deliveryId
             AND status = 'started'
             AND EXISTS (
               SELECT 1 FROM deliveries WHERE id = $deliveryId AND status = 'sending'
             )
           RETURNING id;`,
          {
            attemptId: options.attemptId,
            attemptStatus: options.attemptStatus,
            deliveryId: options.deliveryId,
            errorMessage,
            now,
          },
        );
        if (!updatedAttempt) return;

        yield* db.get<{ id: string }>(
          "sending:delivery:fail",
          `UPDATE deliveries
           SET status = $deliveryStatus, last_error = $errorMessage, updated_at = $now
           WHERE id = $deliveryId AND status = 'sending'
           RETURNING id;`,
          {
            deliveryId: options.deliveryId,
            deliveryStatus: options.deliveryStatus,
            errorMessage,
            now,
          },
        );
      }),
    );
  });
}

function truncate(message: string): string {
  return message.slice(0, maxStoredErrorLength);
}
