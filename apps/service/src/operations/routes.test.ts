import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { withTestApp, type FakeAuthBehavior, type TestRuntime } from "../testing/layers.ts";

function getOperations(
  path: string,
  auth: FakeAuthBehavior,
  options: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return withTestApp({ auth }, async (app) =>
    app.fetch(
      new Request(`http://localhost/api/operations${path}`, {
        headers: options.headers,
      }),
    ),
  );
}

async function seedOperationsData(runtime: TestRuntime): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;

      yield* db.run(
        "test:seed:mailing-1",
        `INSERT INTO mailings (
           id, purpose, state, name, subject, html, text, scheduled_at, created_at, updated_at
         ) VALUES (
           'mailing_1', 'transactional', 'scheduled', 'Ops test', 'Hello',
           '<p>secret-html-body</p>', 'secret-text-body', '2026-07-03T12:00:00.000Z',
           '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:mailing-2",
        `INSERT INTO mailings (
           id, purpose, state, name, subject, html, text, created_at, updated_at
         ) VALUES (
           'mailing_2', 'marketing', 'scheduled', NULL, 'Marketing',
           '<p>marketing body</p>', NULL,
           '2026-07-03T12:01:00.000Z', '2026-07-03T12:01:00.000Z'
         );`,
      );

      yield* db.run(
        "test:seed:contact-2",
        `INSERT INTO contacts (id, email, created_at, updated_at)
         VALUES (
           'contact_2', 'user2@example.com',
           '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z'
         );`,
      );

      yield* db.run(
        "test:seed:delivery-1",
        `INSERT INTO deliveries (
           id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error,
           created_at, updated_at
         ) VALUES (
           'delivery_1', 'mailing_1', 'user1@example.com', NULL, '{"secret":"vars"}',
           'sent', 'ses_1', NULL,
           '2026-07-03T12:00:01.000Z', '2026-07-03T12:00:03.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:delivery-2",
        `INSERT INTO deliveries (
           id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error,
           created_at, updated_at
         ) VALUES (
           'delivery_2', 'mailing_1', 'user2@example.com', 'contact_2', '{"secret":"vars2"}',
           'failed', NULL, 'ambiguous provider outcome',
           '2026-07-03T12:00:02.000Z', '2026-07-03T12:00:05.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:delivery-3",
        `INSERT INTO deliveries (
           id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error,
           created_at, updated_at
         ) VALUES (
           'delivery_3', 'mailing_2', 'user3@example.com', NULL, NULL,
           'queued', NULL, 'retryable smtp problem',
           '2026-07-03T12:00:03.000Z', '2026-07-03T12:00:06.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:delivery-4",
        `INSERT INTO deliveries (
           id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error,
           created_at, updated_at
         ) VALUES (
           'delivery_no_job', 'mailing_1', 'orphan@example.com', NULL, NULL,
           'queued', NULL, NULL,
           '2026-07-03T12:00:04.000Z', '2026-07-03T12:00:04.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:delivery-5",
        `INSERT INTO deliveries (
           id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error,
           created_at, updated_at
         ) VALUES (
           'delivery_attempt_only_issue', 'mailing_1', 'attempt-only@example.com', NULL, NULL,
           'queued', NULL, NULL,
           '2026-07-03T12:00:00.500Z', '2026-07-03T12:00:00.700Z'
         );`,
      );

      yield* db.run(
        "test:seed:job-1",
        `INSERT INTO jobs (
           id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id,
           last_error, created_at, updated_at
         ) VALUES (
           'job_1', 'succeeded', '2026-07-03T12:00:01.000Z', 1, 10,
           NULL, NULL, 'delivery_1', NULL,
           '2026-07-03T12:00:01.000Z', '2026-07-03T12:00:03.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:job-2",
        `INSERT INTO jobs (
           id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id,
           last_error, created_at, updated_at
         ) VALUES (
           'job_2', 'leased', '2026-07-03T12:00:02.000Z', 2, 10,
           'worker_1', '2026-07-03T12:05:00.000Z', 'delivery_2', 'job failed',
           '2026-07-03T12:00:02.000Z', '2026-07-03T12:00:06.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:job-3",
        `INSERT INTO jobs (
           id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id,
           last_error, created_at, updated_at
         ) VALUES (
           'job_3', 'queued', '2026-07-03T12:01:00.000Z', 1, 10,
           NULL, NULL, 'delivery_3', 'retry later',
           '2026-07-03T12:00:03.000Z', '2026-07-03T12:00:07.000Z'
         );`,
      );

      yield* db.run(
        "test:seed:job-5",
        `INSERT INTO jobs (
           id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id,
           last_error, created_at, updated_at
         ) VALUES (
           'job_5', 'succeeded', '2026-07-03T12:00:00.500Z', 1, 10,
           NULL, NULL, 'delivery_attempt_only_issue', NULL,
           '2026-07-03T12:00:00.500Z', '2026-07-03T12:00:00.700Z'
         );`,
      );

      yield* db.run(
        "test:seed:attempt-1",
        `INSERT INTO send_attempts (
           id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message,
           started_at, finished_at
         ) VALUES (
           'attempt_1', 'delivery_1', 'job_1', 1, 'succeeded', 'ses_1', NULL,
           '2026-07-03T12:00:02.000Z', '2026-07-03T12:00:03.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:attempt-2a",
        `INSERT INTO send_attempts (
           id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message,
           started_at, finished_at
         ) VALUES (
           'attempt_2a', 'delivery_2', 'job_2', 1, 'failed', NULL, 'first failed',
           '2026-07-03T12:00:03.000Z', '2026-07-03T12:00:04.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:attempt-2b",
        `INSERT INTO send_attempts (
           id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message,
           started_at, finished_at
         ) VALUES (
           'attempt_2b', 'delivery_2', 'job_2', 2, 'ambiguous', NULL, 'ambiguous provider outcome',
           '2026-07-03T12:00:04.000Z', '2026-07-03T12:00:05.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:attempt-3",
        `INSERT INTO send_attempts (
           id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message,
           started_at, finished_at
         ) VALUES (
           'attempt_3', 'delivery_3', 'job_3', 1, 'failed', NULL, 'retryable smtp problem',
           '2026-07-03T12:00:05.000Z', '2026-07-03T12:00:06.000Z'
         );`,
      );
      yield* db.run(
        "test:seed:attempt-5",
        `INSERT INTO send_attempts (
           id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message,
           started_at, finished_at
         ) VALUES (
           'attempt_5', 'delivery_attempt_only_issue', 'job_5', 1, 'ambiguous', NULL, NULL,
           '2026-07-03T12:00:00.600Z', '2026-07-03T12:00:00.700Z'
         );`,
      );
    }),
  );
}

async function fetchWithSeededData(
  path: string,
  run: (response: Response, runtime: TestRuntime) => Promise<void>,
): Promise<void> {
  await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
    await seedOperationsData(runtime);
    const response = await app.fetch(new Request(`http://localhost/api/operations${path}`));
    await run(response, runtime);
  });
}

describe("operations routes", () => {
  it("enforces auth and operations:read API-key permission", async () => {
    const noAuth = await getOperations("/summary", { session: null });
    expect(noAuth.status).toBe(401);
    await expect(noAuth.json()).resolves.toEqual({
      error: { code: "unauthenticated", message: "Authentication required." },
    });

    const invalidKey = await getOperations(
      "/summary",
      { apiKeyValid: false },
      {
        headers: { "x-api-key": "invalid" },
      },
    );
    expect(invalidKey.status).toBe(401);
    await expect(invalidKey.json()).resolves.toEqual({
      error: { code: "unauthenticated", message: "Invalid API key." },
    });

    const missingPermission = await getOperations(
      "/summary",
      { apiKeyPermissions: { mailings: ["create"] } },
      { headers: { "x-api-key": "valid" } },
    );
    expect(missingPermission.status).toBe(403);
    await expect(missingPermission.json()).resolves.toEqual({
      error: { code: "forbidden", message: "API key does not have the required permissions." },
    });

    const sessionResponse = await getOperations("/summary", { session: { userId: "user_1" } });
    expect(sessionResponse.status).toBe(200);

    const apiKeyResponse = await getOperations(
      "/summary",
      { apiKeyPermissions: { operations: ["read"] } },
      { headers: { "x-api-key": "valid" } },
    );
    expect(apiKeyResponse.status).toBe(200);
  });

  it("returns zero-filled summary counts for an empty database", async () => {
    const response = await getOperations("/summary", { session: { userId: "user_1" } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deliveries: {
        failed: 0,
        queued: 0,
        sending: 0,
        sent: 0,
        suppressed: 0,
      },
      jobs: {
        dead: 0,
        leased: 0,
        queued: 0,
        succeeded: 0,
      },
      recentIssues: [],
      sendAttempts: {
        ambiguous: 0,
        failed: 0,
        started: 0,
        succeeded: 0,
      },
    });
  });

  it("returns summary counts and recent issues", async () => {
    await fetchWithSeededData("/summary", async (response) => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        deliveries: {
          failed: 1,
          queued: 3,
          sending: 0,
          sent: 1,
          suppressed: 0,
        },
        jobs: {
          dead: 0,
          leased: 1,
          queued: 1,
          succeeded: 2,
        },
        recentIssues: [
          {
            id: "job_3",
            kind: "job",
            message: "retry later",
            relatedId: "delivery_3",
            status: "queued",
            updatedAt: "2026-07-03T12:00:07.000Z",
          },
          {
            id: "job_2",
            kind: "job",
            message: "job failed",
            relatedId: "delivery_2",
            status: "leased",
            updatedAt: "2026-07-03T12:00:06.000Z",
          },
          {
            id: "delivery_3",
            kind: "delivery",
            message: "retryable smtp problem",
            relatedId: "mailing_2",
            status: "queued",
            updatedAt: "2026-07-03T12:00:06.000Z",
          },
          {
            id: "attempt_3",
            kind: "send_attempt",
            message: "retryable smtp problem",
            relatedId: "delivery_3",
            status: "failed",
            updatedAt: "2026-07-03T12:00:06.000Z",
          },
          {
            id: "delivery_2",
            kind: "delivery",
            message: "ambiguous provider outcome",
            relatedId: "mailing_1",
            status: "failed",
            updatedAt: "2026-07-03T12:00:05.000Z",
          },
          {
            id: "attempt_2b",
            kind: "send_attempt",
            message: "ambiguous provider outcome",
            relatedId: "delivery_2",
            status: "ambiguous",
            updatedAt: "2026-07-03T12:00:05.000Z",
          },
          {
            id: "attempt_2a",
            kind: "send_attempt",
            message: "first failed",
            relatedId: "delivery_2",
            status: "failed",
            updatedAt: "2026-07-03T12:00:04.000Z",
          },
          {
            id: "attempt_5",
            kind: "send_attempt",
            message: null,
            relatedId: "delivery_attempt_only_issue",
            status: "ambiguous",
            updatedAt: "2026-07-03T12:00:00.700Z",
          },
        ],
        sendAttempts: {
          ambiguous: 2,
          failed: 2,
          started: 0,
          succeeded: 1,
        },
      });
    });
  });

  it("lists deliveries newest first with job and latest-attempt context", async () => {
    await fetchWithSeededData("/deliveries?limit=2", async (response) => {
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: Array<Record<string, unknown>> };

      expect(body.items.map((item) => item.id)).toEqual(["delivery_no_job", "delivery_3"]);
      expect(body.items[0]?.job).toBeNull();
      expect(body.items[0]?.latestAttempt).toBeNull();
      expect(body.items[1]).toMatchObject({
        email: "user3@example.com",
        job: {
          attempts: 1,
          id: "job_3",
          lastError: "retry later",
          lockedUntil: null,
          maxAttempts: 10,
          runAt: "2026-07-03T12:01:00.000Z",
          state: "queued",
        },
        latestAttempt: {
          attemptNo: 1,
          errorMessage: "retryable smtp problem",
          id: "attempt_3",
          status: "failed",
        },
        mailingPurpose: "marketing",
        status: "queued",
      });
    });
  });

  it("filters deliveries by status, issue, email, mailingId, and sesMessageId", async () => {
    await fetchWithSeededData("/deliveries?status=sent", async (response) => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ items: [{ id: "delivery_1" }] });
    });

    await fetchWithSeededData("/deliveries?issue=failed_or_ambiguous", async (response) => {
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: Array<{ id: string }> };
      expect(body.items.map((item) => item.id)).toEqual([
        "delivery_3",
        "delivery_2",
        "delivery_attempt_only_issue",
      ]);
    });

    await fetchWithSeededData("/deliveries?email=USER1@example.com", async (response) => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ items: [{ id: "delivery_1" }] });
    });

    await fetchWithSeededData("/deliveries?mailingId=mailing_2", async (response) => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ items: [{ id: "delivery_3" }] });
    });

    await fetchWithSeededData("/deliveries?sesMessageId=ses_1", async (response) => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ items: [{ id: "delivery_1" }] });
    });
  });

  it("rejects invalid delivery list query params", async () => {
    await Promise.all(
      ["limit=0", "limit=101", "limit=abc", "status=weird", "issue=all"].map(async (query) => {
        const response = await getOperations(`/deliveries?${query}`, {
          session: { userId: "user_1" },
        });
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe("invalid_request");
      }),
    );
  });

  it("returns delivery detail without private message bodies or vars_json", async () => {
    await fetchWithSeededData("/deliveries/delivery_2", async (response) => {
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body).toEqual({
        attempts: [
          {
            attemptNo: 1,
            errorMessage: "first failed",
            finishedAt: "2026-07-03T12:00:04.000Z",
            id: "attempt_2a",
            sesMessageId: null,
            startedAt: "2026-07-03T12:00:03.000Z",
            status: "failed",
          },
          {
            attemptNo: 2,
            errorMessage: "ambiguous provider outcome",
            finishedAt: "2026-07-03T12:00:05.000Z",
            id: "attempt_2b",
            sesMessageId: null,
            startedAt: "2026-07-03T12:00:04.000Z",
            status: "ambiguous",
          },
        ],
        delivery: {
          contactId: "contact_2",
          createdAt: "2026-07-03T12:00:02.000Z",
          email: "user2@example.com",
          id: "delivery_2",
          lastError: "ambiguous provider outcome",
          mailingId: "mailing_1",
          sesMessageId: null,
          status: "failed",
          updatedAt: "2026-07-03T12:00:05.000Z",
        },
        job: {
          attempts: 2,
          createdAt: "2026-07-03T12:00:02.000Z",
          id: "job_2",
          lastError: "job failed",
          lockedBy: "worker_1",
          lockedUntil: "2026-07-03T12:05:00.000Z",
          maxAttempts: 10,
          runAt: "2026-07-03T12:00:02.000Z",
          state: "leased",
          updatedAt: "2026-07-03T12:00:06.000Z",
        },
        mailing: {
          createdAt: "2026-07-03T12:00:00.000Z",
          id: "mailing_1",
          name: "Ops test",
          purpose: "transactional",
          scheduledAt: "2026-07-03T12:00:00.000Z",
          state: "scheduled",
          subject: "Hello",
          updatedAt: "2026-07-03T12:00:00.000Z",
        },
      });

      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("secret-html-body");
      expect(serialized).not.toContain("secret-text-body");
      expect(serialized).not.toContain("vars2");
      expect(serialized).not.toContain("vars_json");
    });
  });

  it("returns null job for delivery detail with no associated job", async () => {
    await fetchWithSeededData("/deliveries/delivery_no_job", async (response) => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        attempts: [],
        delivery: { id: "delivery_no_job" },
        job: null,
      });
    });
  });

  it("lists sanitized SES feedback rows newest first", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await seedOperationsData(runtime);
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;
          yield* db.run(
            "test:seed:feedback-notification",
            `INSERT INTO ses_feedback_notifications (
               sns_message_id, sns_topic_arn, sns_type, event_type, ses_message_id, raw_json, received_at
             ) VALUES (
               'sns_1', 'arn:aws:sns:us-east-1:123456789012:nusend-test', 'Notification',
               'Bounce', 'ses_1', '{"raw":"secret"}', '2026-07-03T12:00:08.000Z'
             );`,
          );
          yield* db.run(
            "test:seed:feedback-recipient",
            `INSERT INTO ses_feedback_recipients (
               id, sns_message_id, event_type, delivery_id, mailing_id, ses_message_id,
               recipient_email, feedback_id, bounce_type, bounce_sub_type,
               complaint_feedback_type, diagnostic_code, action_taken, created_at
             ) VALUES (
               'feedback_1', 'sns_1', 'Bounce', 'delivery_1', 'mailing_1', 'ses_1',
               'user1@example.com', 'feedback-id', 'Permanent', 'General', NULL,
               '${"x".repeat(550)}', 'suppressed', '2026-07-03T12:00:09.000Z'
             );`,
          );
        }),
      );

      const response = await app.fetch(new Request("http://localhost/api/operations/ses-feedback"));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        items: [
          {
            actionTaken: "suppressed",
            bounceSubType: "General",
            bounceType: "Permanent",
            complaintFeedbackType: null,
            createdAt: "2026-07-03T12:00:09.000Z",
            deliveryId: "delivery_1",
            diagnosticCode: `${"x".repeat(500)}…`,
            eventType: "Bounce",
            feedbackId: "feedback-id",
            id: "feedback_1",
            mailingId: "mailing_1",
            recipientEmail: "user1@example.com",
            sesMessageId: "ses_1",
          },
        ],
      });
      expect(JSON.stringify(body)).not.toContain("raw");
      expect(JSON.stringify(body)).not.toContain("secret");
    });
  });

  it("returns generic not_found for a missing delivery detail", async () => {
    const response = await getOperations("/deliveries/missing", { session: { userId: "user_1" } });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Delivery not found." },
    });
  });
});
