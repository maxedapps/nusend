// Scenario assertion values ported 1:1 from the pre-Effect bun-scenario bodies.
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import type { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { runTest } from "../testing/layers.ts";
import { createMailing } from "./create-mailing.ts";
import type { CreateMailingInput } from "./schema.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");
const now = "2026-07-03T12:00:00.000Z";

function baseInput(overrides: Partial<CreateMailingInput>): CreateMailingInput {
  return {
    html: "<p>Hello</p>",
    listId: null,
    name: null,
    purpose: "transactional",
    recipients: null,
    scheduledAt: null,
    subject: "Hello",
    text: null,
    ...overrides,
  };
}

function seedList(
  db: DatabaseService,
  options: { subscribed: boolean } = { subscribed: true },
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    yield* db.run(
      "seed:list",
      "INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Newsletter', $now);",
      { now },
    );
    yield* db.run(
      "seed:contact",
      `INSERT INTO contacts (id, email, attrs_json, created_at, updated_at)
       VALUES ('contact_1', 'subscribed@example.com', '{"firstName":"Sub"}', $now, $now);`,
      { now },
    );
    yield* db.run(
      "seed:contact",
      `INSERT INTO contacts (id, email, attrs_json, created_at, updated_at)
       VALUES ('contact_2', 'unsubscribed@example.com', NULL, $now, $now);`,
      { now },
    );
    yield* db.run(
      "seed:membership",
      `INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at)
       VALUES ('list_1', 'contact_1', $now, $unsubscribedAt);`,
      { now, unsubscribedAt: options.subscribed ? null : now },
    );
    yield* db.run(
      "seed:membership",
      `INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at)
       VALUES ('list_1', 'contact_2', $now, $now);`,
      { now },
    );
  });
}

function countRows(db: DatabaseService) {
  return Effect.gen(function* () {
    return {
      deliveries: (yield* db.get<{ count: number }>(
        "count",
        "SELECT count(*) AS count FROM deliveries;",
      ))?.count,
      jobs: (yield* db.get<{ count: number }>("count", "SELECT count(*) AS count FROM jobs;"))
        ?.count,
      mailings: (yield* db.get<{ count: number }>(
        "count",
        "SELECT count(*) AS count FROM mailings;",
      ))?.count,
    };
  });
}

describe("createMailing", () => {
  it("persists explicit recipients, schedules jobs, and handles suppressions", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const db = yield* Database;

        const result = yield* createMailing(
          baseInput({
            recipients: [{ email: "user@example.com", varsJson: '{"firstName":"Max"}' }],
            text: "Hello",
          }),
        );

        return {
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT email, status, vars_json AS varsJson FROM deliveries;",
          ),
          job: yield* db.get("assert:job", "SELECT kind, state, run_at AS runAt FROM jobs;"),
          mailing: yield* db.get(
            "assert:mailing",
            "SELECT purpose, state, scheduled_at AS scheduledAt FROM mailings;",
          ),
          result,
        };
      }),
    );

    expect(outcome.result.counts).toEqual({ deliveries: 1, queued: 1, suppressed: 0 });
    expect(outcome.result.mailing.scheduledAt).toBe("2026-07-03T12:00:00.000Z");
    expect(outcome.mailing).toEqual({
      purpose: "transactional",
      scheduledAt: "2026-07-03T12:00:00.000Z",
      state: "scheduled",
    });
    expect(outcome.delivery).toEqual({
      email: "user@example.com",
      status: "queued",
      varsJson: '{"firstName":"Max"}',
    });
    expect(outcome.job).toEqual({
      kind: "send_delivery",
      runAt: "2026-07-03T12:00:00.000Z",
      state: "queued",
    });
  });

  it("uses provided scheduledAt for the mailing and queued jobs", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const db = yield* Database;

        yield* createMailing(
          baseInput({
            recipients: [{ email: "user@example.com", varsJson: null }],
            scheduledAt: "2026-08-01T10:00:00.000Z",
          }),
        );

        return {
          job: yield* db.get<{ runAt: string }>("assert:job", "SELECT run_at AS runAt FROM jobs;"),
          mailing: yield* db.get<{ scheduledAt: string }>(
            "assert:mailing",
            "SELECT scheduled_at AS scheduledAt FROM mailings;",
          ),
        };
      }),
    );

    expect(outcome.mailing?.scheduledAt).toBe("2026-08-01T10:00:00.000Z");
    expect(outcome.job?.runAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("links explicit recipients to existing contacts without creating contacts", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const db = yield* Database;

        yield* db.run(
          "seed:contact",
          `INSERT INTO contacts (id, email, attrs_json, created_at, updated_at)
           VALUES ('contact_1', 'USER@example.com', NULL, $now, $now);`,
          { now },
        );

        yield* createMailing(
          baseInput({ recipients: [{ email: "user@example.com", varsJson: null }] }),
        );

        return {
          contactCount: yield* db.get<{ count: number }>(
            "assert:contacts",
            "SELECT count(*) AS count FROM contacts;",
          ),
          delivery: yield* db.get<{ contactId: string }>(
            "assert:delivery",
            "SELECT contact_id AS contactId FROM deliveries;",
          ),
        };
      }),
    );

    expect(outcome.delivery?.contactId).toBe("contact_1");
    expect(outcome.contactCount?.count).toBe(1);
  });

  it("snapshots subscribed list contacts only", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const db = yield* Database;
        yield* seedList(db);

        yield* createMailing(
          baseInput({ listId: "list_1", name: "Newsletter", purpose: "marketing" }),
        );

        return {
          deliveries: yield* db.all(
            "assert:deliveries",
            "SELECT email, contact_id AS contactId, vars_json AS varsJson, status FROM deliveries ORDER BY email;",
          ),
          jobCount: yield* db.get<{ count: number }>(
            "assert:jobs",
            "SELECT count(*) AS count FROM jobs;",
          ),
        };
      }),
    );

    expect(outcome.deliveries).toEqual([
      { contactId: "contact_1", email: "subscribed@example.com", status: "queued", varsJson: null },
    ]);
    expect(outcome.jobCount?.count).toBe(1);
  });

  it("applies global, marketing, and list suppression rules", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const db = yield* Database;

        yield* db.run(
          "seed:list",
          "INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Newsletter', $now);",
          { now },
        );
        yield* db.run(
          "seed:list",
          "INSERT INTO lists (id, name, created_at) VALUES ('list_2', 'Other', $now);",
          { now },
        );
        for (const [id, email] of [
          ["contact_ok", "ok@example.com"],
          ["contact_global", "global@example.com"],
          ["contact_marketing", "marketing@example.com"],
          ["contact_list", "list@example.com"],
          ["contact_other_list", "other-list@example.com"],
        ] as const) {
          yield* db.run(
            "seed:contact",
            `INSERT INTO contacts (id, email, attrs_json, created_at, updated_at)
             VALUES ($id, $email, NULL, $now, $now);`,
            { email, id, now },
          );
          yield* db.run(
            "seed:membership",
            `INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at)
             VALUES ('list_1', $id, $now, NULL);`,
            { id, now },
          );
        }
        const suppressions = [
          { email: "global@example.com", id: "sup_1", listId: null, scope: "all" },
          { email: "marketing@example.com", id: "sup_2", listId: null, scope: "marketing" },
          { email: "list@example.com", id: "sup_3", listId: "list_1", scope: "list" },
          { email: "other-list@example.com", id: "sup_4", listId: "list_2", scope: "list" },
        ];
        for (const suppression of suppressions) {
          yield* db.run(
            "seed:suppression",
            `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
             VALUES ($id, $email, $scope, $listId, 'manual', $now);`,
            { ...suppression, now },
          );
        }

        const marketing = yield* createMailing(
          baseInput({ listId: "list_1", purpose: "marketing" }),
        );
        const jobCount = yield* db.get<{ count: number }>(
          "assert:jobs",
          "SELECT count(*) AS count FROM jobs;",
        );

        const transactional = yield* createMailing(
          baseInput({
            recipients: [
              { email: "ok2@example.com", varsJson: null },
              { email: "marketing@example.com", varsJson: null },
              { email: "list@example.com", varsJson: null },
              { email: "global@example.com", varsJson: null },
            ],
          }),
        );

        return { jobCount, marketing, transactional };
      }),
    );

    expect(outcome.marketing.counts).toEqual({ deliveries: 5, queued: 2, suppressed: 3 });
    expect(outcome.jobCount?.count).toBe(2);
    expect(outcome.transactional.counts).toEqual({ deliveries: 4, queued: 3, suppressed: 1 });
  });

  it("rejects empty, all-suppressed, and missing-list requests without writes", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const db = yield* Database;
        yield* seedList(db, { subscribed: false });

        const emptyList = yield* createMailing(
          baseInput({ listId: "list_1", purpose: "marketing" }),
        ).pipe(
          Effect.map(() => "unexpected success"),
          Effect.catchTag("EmptyRecipientSetError", () => Effect.succeed("empty_recipient_set")),
        );
        const afterEmptyList = yield* countRows(db);

        yield* db.run(
          "seed:suppression",
          `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
           VALUES ('sup_1', 'only@example.com', 'all', NULL, 'manual', $now);`,
          { now },
        );
        const allSuppressed = yield* createMailing(
          baseInput({ recipients: [{ email: "only@example.com", varsJson: null }] }),
        ).pipe(
          Effect.map(() => "unexpected success"),
          Effect.catchTag("EmptyRecipientSetError", () => Effect.succeed("empty_recipient_set")),
        );
        const afterAllSuppressed = yield* countRows(db);

        const missingList = yield* createMailing(
          baseInput({ listId: "missing", purpose: "marketing" }),
        ).pipe(
          Effect.map(() => "unexpected success"),
          Effect.catchTag("ListNotFoundError", () => Effect.succeed("list_not_found")),
        );
        const afterMissingList = yield* countRows(db);

        return {
          afterAllSuppressed,
          afterEmptyList,
          afterMissingList,
          allSuppressed,
          emptyList,
          missingList,
        };
      }),
    );

    expect(outcome.emptyList).toBe("empty_recipient_set");
    expect(outcome.afterEmptyList).toEqual({ deliveries: 0, jobs: 0, mailings: 0 });
    expect(outcome.allSuppressed).toBe("empty_recipient_set");
    expect(outcome.afterAllSuppressed).toEqual({ deliveries: 0, jobs: 0, mailings: 0 });
    expect(outcome.missingList).toBe("list_not_found");
    expect(outcome.afterMissingList).toEqual({ deliveries: 0, jobs: 0, mailings: 0 });
  });

  it("rolls back all writes when an insert fails mid-transaction", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const db = yield* Database;

        const failure = yield* createMailing(
          baseInput({
            recipients: [
              { email: "one@example.com", varsJson: null },
              { email: "two@example.com", varsJson: null },
            ],
          }),
        ).pipe(
          Effect.map(() => "unexpected success"),
          Effect.catchTag("DatabaseError", (error) =>
            Effect.succeed(`database_error:${error.operation}`),
          ),
        );

        return { counts: yield* countRows(db), failure };
      }),
      // Duplicate delivery id on the second recipient forces a mid-transaction
      // constraint failure (same collision the pre-Effect scenario used).
      { ids: ["mailing_1", "delivery_1", "job_1", "delivery_1"] },
    );

    expect(outcome.failure).toBe("database_error:deliveries:insert");
    expect(outcome.counts).toEqual({ deliveries: 0, jobs: 0, mailings: 0 });
  });
});
