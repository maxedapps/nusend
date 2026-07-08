import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { createMailing } from "../mailings/create-mailing.ts";
import type { CreateMailingInput } from "../mailings/schema.ts";
import type { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { runTest } from "../testing/layers.ts";
import {
  recordRetryableFailure,
  recordSendSuccess,
  recordStaleSendingAsAmbiguous,
} from "./attempts.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

function baseInput(): CreateMailingInput {
  return {
    html: "<p>Hello</p>",
    listId: null,
    name: null,
    purpose: "transactional",
    recipients: [{ email: "user@example.com", varsJson: null }],
    scheduledAt: null,
    subject: "Hello",
    text: "Hi",
  };
}

describe("send attempt outcome recording", () => {
  it("ignores late retryable failures after stale ambiguity resolution", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:resolved-delivery",
          `UPDATE deliveries
           SET status = 'failed', last_error = 'stale ambiguity', updated_at = '2026-07-03T12:00:00.000Z'
           WHERE id = $deliveryId;`,
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:resolved-job",
          "UPDATE jobs SET state = 'succeeded' WHERE id = $jobId;",
          { jobId: row.jobId },
        );
        yield* db.run(
          "seed:ambiguous-attempt",
          `INSERT INTO send_attempts (
             id, delivery_id, job_id, attempt_no, status, error_message, started_at, finished_at
           ) VALUES (
             'attempt_1', $deliveryId, $jobId, 1, 'ambiguous', 'stale ambiguity',
             '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z'
           );`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        yield* recordRetryableFailure({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          errorMessage: "late retryable failure",
        });

        return yield* currentState();
      }),
    );

    expect(result).toEqual({
      attemptError: "stale ambiguity",
      attemptMessageId: null,
      attemptStatus: "ambiguous",
      deliveryError: "stale ambiguity",
      deliveryMessageId: null,
      deliveryStatus: "failed",
      jobState: "succeeded",
    });
  });

  it("ignores late success after stale ambiguity resolution", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:resolved-delivery",
          `UPDATE deliveries
           SET status = 'failed', last_error = 'stale ambiguity', updated_at = '2026-07-03T12:00:00.000Z'
           WHERE id = $deliveryId;`,
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:resolved-job",
          "UPDATE jobs SET state = 'succeeded' WHERE id = $jobId;",
          { jobId: row.jobId },
        );
        yield* db.run(
          "seed:ambiguous-attempt",
          `INSERT INTO send_attempts (
             id, delivery_id, job_id, attempt_no, status, error_message, started_at, finished_at
           ) VALUES (
             'attempt_1', $deliveryId, $jobId, 1, 'ambiguous', 'stale ambiguity',
             '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z'
           );`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        yield* recordSendSuccess({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          messageId: "late-message-id",
        });

        return yield* currentState();
      }),
    );

    expect(result).toEqual({
      attemptError: "stale ambiguity",
      attemptMessageId: null,
      attemptStatus: "ambiguous",
      deliveryError: "stale ambiguity",
      deliveryMessageId: null,
      deliveryStatus: "failed",
      jobState: "succeeded",
    });
  });

  it("does not record retryable failure when the attempt is still started but the delivery is terminal", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:terminal-delivery",
          `UPDATE deliveries
           SET status = 'failed', last_error = 'already resolved', updated_at = '2026-07-03T12:00:00.000Z'
           WHERE id = $deliveryId;`,
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:started-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
           VALUES ('attempt_1', $deliveryId, $jobId, 1, 'started', '2026-07-03T12:00:00.000Z');`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        yield* recordRetryableFailure({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          errorMessage: "late retryable failure",
        });

        return yield* currentState();
      }),
    );

    expect(result).toEqual({
      attemptError: null,
      attemptMessageId: null,
      attemptStatus: "started",
      deliveryError: "already resolved",
      deliveryMessageId: null,
      deliveryStatus: "failed",
      jobState: "queued",
    });
  });

  it("does not record success when the attempt is still started but the delivery is terminal", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:terminal-delivery",
          `UPDATE deliveries
           SET status = 'failed', last_error = 'already resolved', updated_at = '2026-07-03T12:00:00.000Z'
           WHERE id = $deliveryId;`,
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:started-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
           VALUES ('attempt_1', $deliveryId, $jobId, 1, 'started', '2026-07-03T12:00:00.000Z');`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        yield* recordSendSuccess({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          messageId: "late-message-id",
        });

        return yield* currentState();
      }),
    );

    expect(result).toEqual({
      attemptError: null,
      attemptMessageId: null,
      attemptStatus: "started",
      deliveryError: "already resolved",
      deliveryMessageId: null,
      deliveryStatus: "failed",
      jobState: "queued",
    });
  });

  it("does not mark completed attempts as stale ambiguous", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:sending-delivery",
          "UPDATE deliveries SET status = 'sending' WHERE id = $deliveryId;",
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:succeeded-attempt",
          `INSERT INTO send_attempts (
             id, delivery_id, job_id, attempt_no, status, ses_message_id, started_at, finished_at
           ) VALUES (
             'attempt_1', $deliveryId, $jobId, 1, 'succeeded', 'message_1',
             '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z'
           );`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        yield* recordStaleSendingAsAmbiguous({
          deliveryId: row.deliveryId,
          errorMessage: "stale marker",
        });

        return yield* currentState();
      }),
    );

    expect(result).toEqual({
      attemptError: null,
      attemptMessageId: "message_1",
      attemptStatus: "succeeded",
      deliveryError: null,
      deliveryMessageId: null,
      deliveryStatus: "sending",
      jobState: "queued",
    });
  });
});

function deliveryAndJob(): Effect.Effect<
  { deliveryId: string; jobId: string },
  DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{ deliveryId: string; jobId: string }>(
      "test:delivery-job",
      `SELECT deliveries.id AS deliveryId, jobs.id AS jobId
       FROM deliveries
       INNER JOIN jobs ON jobs.delivery_id = deliveries.id
       LIMIT 1;`,
    );
    if (!row) throw new Error("Expected seeded delivery and job.");
    return row;
  });
}

function currentState(): Effect.Effect<
  {
    attemptError: string | null;
    attemptMessageId: string | null;
    attemptStatus: string;
    deliveryError: string | null;
    deliveryMessageId: string | null;
    deliveryStatus: string;
    jobState: string;
  },
  DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{
      attemptError: string | null;
      attemptMessageId: string | null;
      attemptStatus: string;
      deliveryError: string | null;
      deliveryMessageId: string | null;
      deliveryStatus: string;
      jobState: string;
    }>(
      "test:current-state",
      `SELECT
         send_attempts.error_message AS attemptError,
         send_attempts.ses_message_id AS attemptMessageId,
         send_attempts.status AS attemptStatus,
         deliveries.last_error AS deliveryError,
         deliveries.ses_message_id AS deliveryMessageId,
         deliveries.status AS deliveryStatus,
         jobs.state AS jobState
       FROM deliveries
       INNER JOIN jobs ON jobs.delivery_id = deliveries.id
       INNER JOIN send_attempts ON send_attempts.delivery_id = deliveries.id
       LIMIT 1;`,
    );
    if (!row) throw new Error("Expected current state row.");
    return row;
  });
}
