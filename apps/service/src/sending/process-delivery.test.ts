import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { createMailing } from "../mailings/create-mailing.ts";
import type { CreateMailingInput } from "../mailings/schema.ts";
import { runSendWorkerOnce } from "../queue/runner.ts";
import { Database } from "../services/database.ts";
import { EmailTransportError } from "../services/email-transport.ts";
import { fakeEmailTransportLayer, fakeSendingConfigLayer } from "../testing/email-transport.ts";
import { runTest, type TestServices } from "../testing/layers.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

function baseInput(overrides: Partial<CreateMailingInput> = {}): CreateMailingInput {
  return {
    html: "<p>Hello {{ vars.firstName }}</p>",
    listId: null,
    name: null,
    purpose: "transactional",
    recipients: [{ email: "user@example.com", varsJson: '{"firstName":"Max"}' }],
    scheduledAt: null,
    subject: "Hello {{ user.email }}",
    text: "Hi {{ vars.firstName }}",
    ...overrides,
  };
}

function runSendingScenario<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const fake = fakeEmailTransportLayer();
  const provided = effect.pipe(
    Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer())),
  ) as Effect.Effect<A, E, TestServices>;

  return runTest(provided).then((result) => ({ result, sent: fake.state.sent }));
}

describe("processSendDeliveryJob", () => {
  it("sends transactional deliveries and lets the queue runner complete the job", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        const db = yield* Database;
        return {
          attempt: yield* db.get(
            "assert:attempt",
            "SELECT status, ses_message_id AS sesMessageId FROM send_attempts;",
          ),
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, ses_message_id AS sesMessageId, last_error AS lastError FROM deliveries;",
          ),
          job: yield* db.get("assert:job", "SELECT state FROM jobs;"),
          result,
        };
      }),
    );

    expect(outcome.result.result.succeeded).toBe(1);
    expect(outcome.result.job).toEqual({ state: "succeeded" });
    expect(outcome.result.delivery).toEqual({
      lastError: null,
      sesMessageId: "fake-message-1",
      status: "sent",
    });
    expect(outcome.result.attempt).toEqual({ sesMessageId: "fake-message-1", status: "succeeded" });
    expect(outcome.sent).toEqual([
      expect.objectContaining({
        configurationSetName: "txn-config",
        from: "sender@example.com",
        html: "<p>Hello Max</p>",
        subject: "Hello user@example.com",
        text: "Hi Max",
        to: "user@example.com",
      }),
    ]);
  });

  it("keeps multi-recipient mailings sending until all delivery jobs are terminal", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(
          baseInput({
            recipients: [
              { email: "alice@example.com", varsJson: '{"firstName":"Alice"}' },
              { email: "bob@example.com", varsJson: '{"firstName":"Bob"}' },
            ],
          }),
        );
        const db = yield* Database;

        const setup = {
          deliveries: yield* db.get<{ count: number }>(
            "assert:setup-deliveries",
            "SELECT count(*) AS count FROM deliveries;",
          ),
          jobs: yield* db.get<{ count: number }>(
            "assert:setup-jobs",
            "SELECT count(*) AS count FROM jobs;",
          ),
        };

        // Sequential IDs and identical run_at values make batchSize: 1 claim recipient order.
        const firstResult = yield* runSendWorkerOnce({ batchSize: 1, workerId: "worker_1" });
        const afterFirst = {
          deliveries: yield* db.all(
            "assert:first-deliveries",
            "SELECT email, status FROM deliveries ORDER BY email ASC;",
          ),
          jobs: yield* db.all("assert:first-jobs", "SELECT state FROM jobs ORDER BY id ASC;"),
          mailing: yield* db.get("assert:first-mailing", "SELECT state FROM mailings;"),
        };

        const secondResult = yield* runSendWorkerOnce({ batchSize: 1, workerId: "worker_1" });
        const afterSecond = {
          deliveries: yield* db.all(
            "assert:second-deliveries",
            "SELECT email, status FROM deliveries ORDER BY email ASC;",
          ),
          jobs: yield* db.all("assert:second-jobs", "SELECT state FROM jobs ORDER BY id ASC;"),
          mailing: yield* db.get("assert:second-mailing", "SELECT state FROM mailings;"),
        };

        return { afterFirst, afterSecond, firstResult, secondResult, setup };
      }),
    );

    expect(outcome.result.setup).toEqual({ deliveries: { count: 2 }, jobs: { count: 2 } });
    expect(outcome.result.firstResult).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(outcome.result.afterFirst.deliveries).toEqual([
      { email: "alice@example.com", status: "sent" },
      { email: "bob@example.com", status: "queued" },
    ]);
    expect(outcome.result.afterFirst.jobs).toEqual([{ state: "succeeded" }, { state: "queued" }]);
    expect(outcome.result.afterFirst.mailing).toEqual({ state: "sending" });

    expect(outcome.result.secondResult).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(outcome.result.afterSecond.deliveries).toEqual([
      { email: "alice@example.com", status: "sent" },
      { email: "bob@example.com", status: "sent" },
    ]);
    expect(outcome.result.afterSecond.jobs).toEqual([
      { state: "succeeded" },
      { state: "succeeded" },
    ]);
    expect(outcome.result.afterSecond.mailing).toEqual({ state: "completed" });
    expect(outcome.sent.map((email) => email.to)).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("records retryable transport failures and lets the queue runner requeue", async () => {
    const fake = fakeEmailTransportLayer([
      {
        kind: "Fail",
        error: new EmailTransportError({ kind: "retryable", operation: "send" }),
      },
    ]);

    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        const db = yield* Database;
        return {
          attempt: yield* db.get(
            "assert:attempt",
            "SELECT status, error_message AS errorMessage FROM send_attempts;",
          ),
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          job: yield* db.get("assert:job", "SELECT state, last_error AS lastError FROM jobs;"),
          mailing: yield* db.get("assert:mailing", "SELECT state FROM mailings;"),
          result,
        };
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome.result.failed).toBe(1);
    expect(outcome.job).toEqual({
      lastError: "Email transport retryable failure.",
      state: "queued",
    });
    expect(outcome.delivery).toEqual({
      lastError: "Email transport retryable failure.",
      status: "queued",
    });
    expect(outcome.mailing).toEqual({ state: "sending" });
    expect(outcome.attempt).toEqual({
      errorMessage: "Email transport retryable failure.",
      status: "failed",
    });
    expect(fake.state.sent).toHaveLength(1);
  });

  it("retries a retryable transport failure across worker runs", async () => {
    const fake = fakeEmailTransportLayer([
      {
        kind: "Fail",
        error: new EmailTransportError({ kind: "retryable", operation: "send" }),
      },
      { kind: "Succeed", result: { messageId: "fake-message-2" } },
    ]);

    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;

        const firstResult = yield* runSendWorkerOnce({ workerId: "worker_1" });
        const afterFirst = {
          attempt: yield* db.get(
            "assert:first-attempt",
            "SELECT attempt_no AS attemptNo, status, error_message AS errorMessage FROM send_attempts;",
          ),
          delivery: yield* db.get(
            "assert:first-delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          job: yield* db.get(
            "assert:first-job",
            "SELECT state, attempts, last_error AS lastError FROM jobs;",
          ),
          mailing: yield* db.get("assert:first-mailing", "SELECT state FROM mailings;"),
        };

        yield* TestClock.setTime(Date.parse("2026-07-03T12:02:00.000Z"));
        const secondResult = yield* runSendWorkerOnce({ workerId: "worker_1" });

        return {
          afterFirst,
          afterSecond: {
            attempts: yield* db.all(
              "assert:attempts",
              `SELECT attempt_no AS attemptNo, status, ses_message_id AS sesMessageId, error_message AS errorMessage
               FROM send_attempts
               ORDER BY attempt_no ASC;`,
            ),
            delivery: yield* db.get(
              "assert:second-delivery",
              "SELECT status, ses_message_id AS sesMessageId, last_error AS lastError FROM deliveries;",
            ),
            job: yield* db.get(
              "assert:second-job",
              "SELECT state, attempts, last_error AS lastError FROM jobs;",
            ),
            mailing: yield* db.get("assert:second-mailing", "SELECT state FROM mailings;"),
          },
          firstResult,
          secondResult,
        };
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome.firstResult.failed).toBe(1);
    expect(outcome.afterFirst.job).toEqual({
      attempts: 1,
      lastError: "Email transport retryable failure.",
      state: "queued",
    });
    expect(outcome.afterFirst.delivery).toEqual({
      lastError: "Email transport retryable failure.",
      status: "queued",
    });
    expect(outcome.afterFirst.mailing).toEqual({ state: "sending" });
    expect(outcome.afterFirst.attempt).toEqual({
      attemptNo: 1,
      errorMessage: "Email transport retryable failure.",
      status: "failed",
    });

    expect(outcome.secondResult.succeeded).toBe(1);
    expect(outcome.afterSecond.job).toEqual({ attempts: 2, lastError: null, state: "succeeded" });
    expect(outcome.afterSecond.delivery).toEqual({
      lastError: null,
      sesMessageId: "fake-message-2",
      status: "sent",
    });
    expect(outcome.afterSecond.mailing).toEqual({ state: "completed" });
    expect(outcome.afterSecond.attempts).toEqual([
      {
        attemptNo: 1,
        errorMessage: "Email transport retryable failure.",
        sesMessageId: null,
        status: "failed",
      },
      { attemptNo: 2, errorMessage: null, sesMessageId: "fake-message-2", status: "succeeded" },
    ]);
    expect(fake.state.sent).toHaveLength(2);
  });

  it("marks delivery failed and mailing completed when a retryable failure exhausts attempts", async () => {
    const fake = fakeEmailTransportLayer([
      {
        kind: "Fail",
        error: new EmailTransportError({ kind: "retryable", operation: "send" }),
      },
    ]);

    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        yield* db.run("force:max-attempts", "UPDATE jobs SET max_attempts = 1;");

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        return {
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          job: yield* db.get("assert:job", "SELECT state, last_error AS lastError FROM jobs;"),
          mailing: yield* db.get("assert:mailing", "SELECT state FROM mailings;"),
          result,
        };
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome.result.dead).toBe(1);
    expect(outcome.job).toEqual({
      lastError: "Email transport retryable failure.",
      state: "dead",
    });
    expect(outcome.delivery).toEqual({
      lastError: "Email transport retryable failure.",
      status: "failed",
    });
    expect(outcome.mailing).toEqual({ state: "completed" });
  });

  it("records ambiguous transport failures as terminal ambiguous outcomes", async () => {
    const fake = fakeEmailTransportLayer([
      {
        kind: "Fail",
        error: new EmailTransportError({ kind: "ambiguous", operation: "send" }),
      },
    ]);

    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        const db = yield* Database;
        return {
          attempt: yield* db.get(
            "assert:attempt",
            "SELECT status, error_message AS errorMessage FROM send_attempts;",
          ),
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          job: yield* db.get("assert:job", "SELECT state, last_error AS lastError FROM jobs;"),
          result,
        };
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome.result.succeeded).toBe(1);
    expect(outcome.job).toEqual({ lastError: null, state: "succeeded" });
    expect(outcome.delivery).toEqual({
      lastError: "Email transport ambiguous failure.",
      status: "failed",
    });
    expect(outcome.attempt).toEqual({
      errorMessage: "Email transport ambiguous failure.",
      status: "ambiguous",
    });
    expect(fake.state.sent).toHaveLength(1);
  });

  it("records permanent transport failures as terminal failed deliveries", async () => {
    const fake = fakeEmailTransportLayer([
      {
        kind: "Fail",
        error: new EmailTransportError({ kind: "permanent", operation: "send" }),
      },
    ]);

    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        const db = yield* Database;
        return {
          attempt: yield* db.get(
            "assert:attempt",
            "SELECT status, error_message AS errorMessage FROM send_attempts;",
          ),
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          job: yield* db.get("assert:job", "SELECT state, last_error AS lastError FROM jobs;"),
          mailing: yield* db.get("assert:mailing", "SELECT state FROM mailings;"),
          result,
        };
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome.result.succeeded).toBe(1);
    expect(outcome.job).toEqual({ lastError: null, state: "succeeded" });
    expect(outcome.delivery).toEqual({
      lastError: "Email transport permanent failure.",
      status: "failed",
    });
    expect(outcome.attempt).toEqual({
      errorMessage: "Email transport permanent failure.",
      status: "failed",
    });
    expect(outcome.mailing).toEqual({ state: "completed" });
    expect(fake.state.sent).toHaveLength(1);
  });

  it("blocks marketing sends as a terminal policy failure", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput({ purpose: "marketing" }));

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        const db = yield* Database;
        return {
          attempt: yield* db.get(
            "assert:attempt",
            "SELECT status, error_message AS errorMessage FROM send_attempts;",
          ),
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          job: yield* db.get("assert:job", "SELECT state FROM jobs;"),
          result,
        };
      }),
    );

    expect(outcome.result.result.succeeded).toBe(1);
    expect(outcome.result.job).toEqual({ state: "succeeded" });
    expect(outcome.result.delivery).toEqual({
      lastError: "Marketing sending requires unsubscribe support.",
      status: "failed",
    });
    expect(outcome.result.attempt).toEqual({
      errorMessage: "Marketing sending requires unsubscribe support.",
      status: "failed",
    });
    expect(outcome.sent).toHaveLength(0);
  });

  it("re-checks global suppressions before transactional sending", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        yield* db.run(
          "seed:suppression",
          `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
           VALUES ('sup_1', 'user@example.com', 'all', NULL, 'manual', '2026-07-03T12:00:00.000Z');`,
        );

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        return {
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          result,
        };
      }),
    );

    expect(outcome.result.result.succeeded).toBe(1);
    expect(outcome.result.delivery).toEqual({
      lastError: "Recipient is globally suppressed.",
      status: "suppressed",
    });
    expect(outcome.sent).toHaveLength(0);
  });

  it("escapes HTML placeholder values while leaving subject/text substitutions plain", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(
          baseInput({
            html: "<p>{{ vars.name }}</p>",
            recipients: [
              { email: "user@example.com", varsJson: JSON.stringify({ name: `<script>&"'` }) },
            ],
            subject: "Hello {{ vars.name }}",
            text: "Hi {{ vars.name }}",
          }),
        );

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        return { result };
      }),
    );

    expect(outcome.result.result.succeeded).toBe(1);
    expect(outcome.sent).toEqual([
      expect.objectContaining({
        html: "<p>&lt;script&gt;&amp;&quot;&#39;</p>",
        subject: `Hello <script>&"'`,
        text: `Hi <script>&"'`,
      }),
    ]);
  });

  it("fails unsupported placeholders without calling transport", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput({ html: "<p>{{ vars.missing }}</p>" }));

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        const db = yield* Database;
        return {
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          result,
        };
      }),
    );

    expect(outcome.result.result.succeeded).toBe(1);
    expect(outcome.result.delivery).toEqual({
      lastError: "Missing placeholder value: vars.missing.",
      status: "failed",
    });
    expect(outcome.sent).toHaveLength(0);
  });

  it("fails invalid vars_json without calling transport", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        yield* db.run("corrupt:vars", "UPDATE deliveries SET vars_json = '{';");

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        return {
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          result,
        };
      }),
    );

    expect(outcome.result.result.succeeded).toBe(1);
    expect(outcome.result.delivery).toEqual({
      lastError: "Recipient vars_json is invalid.",
      status: "failed",
    });
    expect(outcome.sent).toHaveLength(0);
  });

  it("fails non-scalar vars without calling transport", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(
          baseInput({
            html: "<p>{{ vars.name }}</p>",
            recipients: [{ email: "user@example.com", varsJson: '{"name":{"nested":true}}' }],
          }),
        );

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        const db = yield* Database;
        return {
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          result,
        };
      }),
    );

    expect(outcome.result.result.succeeded).toBe(1);
    expect(outcome.result.delivery).toEqual({
      lastError: "Placeholder is not scalar: vars.name.",
      status: "failed",
    });
    expect(outcome.sent).toHaveLength(0);
  });

  it("skips terminal deliveries without calling transport", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        yield* db.run("mark:sent", "UPDATE deliveries SET status = 'sent';");

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        return {
          attempts: yield* db.get<{ count: number }>(
            "assert:attempts",
            "SELECT count(*) AS count FROM send_attempts;",
          ),
          job: yield* db.get("assert:job", "SELECT state FROM jobs;"),
          result,
        };
      }),
    );

    expect(outcome.result.result.succeeded).toBe(1);
    expect(outcome.result.job).toEqual({ state: "succeeded" });
    expect(outcome.result.attempts?.count).toBe(0);
    expect(outcome.sent).toHaveLength(0);
  });

  it("marks stale in-flight deliveries as ambiguous without calling transport", async () => {
    const outcome = await runSendingScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        yield* db.run("mark:sending", "UPDATE deliveries SET status = 'sending';");
        yield* db.run(
          "seed:started-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
           SELECT 'attempt_1', deliveries.id, jobs.id, 1, 'started', '2026-07-03T12:00:00.000Z'
           FROM deliveries, jobs
           LIMIT 1;`,
        );

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        return {
          attempt: yield* db.get(
            "assert:attempt",
            "SELECT status, error_message AS errorMessage, finished_at AS finishedAt FROM send_attempts;",
          ),
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          job: yield* db.get("assert:job", "SELECT state FROM jobs;"),
          result,
        };
      }),
    );

    expect(outcome.result.result.succeeded).toBe(1);
    expect(outcome.result.job).toEqual({ state: "succeeded" });
    expect(outcome.result.delivery).toEqual({
      lastError: "Delivery was left sending by a previous attempt; outcome is ambiguous.",
      status: "failed",
    });
    expect(outcome.result.attempt).toEqual({
      errorMessage: "Delivery was left sending by a previous attempt; outcome is ambiguous.",
      finishedAt: "2026-07-03T12:00:00.000Z",
      status: "ambiguous",
    });
    expect(outcome.sent).toHaveLength(0);
  });
});
