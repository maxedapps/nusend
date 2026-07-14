import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { createMailing } from "../mailings/create-mailing.ts";
import type { CreateMailingInput } from "../mailings/schema.ts";
import { Database } from "../services/database.ts";
import { seedSubscribedContact } from "../testing/contact-fixtures.ts";
import { fakeUnsubscribeConfig, runTest } from "../testing/layers.ts";
import { signUnsubscribeToken } from "./token.ts";
import { unsubscribeByToken } from "./unsubscribe.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

function input(overrides: Partial<CreateMailingInput> = {}): CreateMailingInput {
  return {
    html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
    listId: null,
    name: null,
    purpose: "marketing",
    recipients: [{ email: "User@Example.com", varsJson: null }],
    scheduledAt: null,
    subject: "Hello",
    text: null,
    ...overrides,
  };
}

describe("unsubscribeByToken", () => {
  it("writes one idempotent marketing suppression case-insensitively", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(input());
        const db = yield* Database;
        const delivery = yield* db.get<{ id: string }>(
          "assert:delivery",
          "SELECT id FROM deliveries LIMIT 1;",
        );
        const token = signUnsubscribeToken(
          delivery?.id ?? "missing",
          fakeUnsubscribeConfig().currentSecret,
        );
        yield* db.run(
          "test:manual-marketing-suppression",
          `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
           VALUES ('supp_manual', 'USER@example.com', 'marketing', NULL, 'manual', '2026-07-01T00:00:00.000Z');`,
        );

        const first = yield* unsubscribeByToken(token, "one-click");
        const second = yield* unsubscribeByToken(token, "human");

        return {
          first,
          second,
          suppressions: yield* db.all(
            "assert:suppressions",
            `SELECT id, lower(email) AS email, scope, list_id AS listId, reason,
                    created_at AS createdAt
             FROM suppressions;`,
          ),
        };
      }),
      { unsubscribe: Option.some(fakeUnsubscribeConfig()) },
    );

    expect(result.first).toMatchObject({ kind: "Success", appliedMarketingUnsubscribe: true });
    expect(result.second).toMatchObject({ kind: "Success", appliedMarketingUnsubscribe: true });
    expect(result.suppressions).toEqual([
      {
        createdAt: "2026-07-01T00:00:00.000Z",
        email: "user@example.com",
        id: "supp_manual",
        listId: null,
        reason: "unsubscribe",
        scope: "marketing",
      },
    ]);
  });

  it("updates originating list membership as secondary state", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const db = yield* Database;
        yield* seedSubscribedContact({ email: "User@Example.com", listId: "list_1" });
        yield* createMailing(input({ listId: "list_1", recipients: null }));
        const delivery = yield* db.get<{ id: string }>(
          "assert:delivery",
          "SELECT id FROM deliveries LIMIT 1;",
        );
        const token = signUnsubscribeToken(
          delivery?.id ?? "missing",
          fakeUnsubscribeConfig().currentSecret,
        );

        yield* unsubscribeByToken(token, "human");

        return yield* db.get(
          "assert:membership",
          "SELECT unsubscribed_at AS unsubscribedAt FROM list_memberships;",
        );
      }),
      { unsubscribe: Option.some(fakeUnsubscribeConfig()) },
    );

    expect(result).toEqual({ unsubscribedAt: "2026-07-03T12:00:00.000Z" });
  });

  it("does not create marketing suppressions for transactional deliveries", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(
          input({
            html: "<p>Hello</p>",
            purpose: "transactional",
            recipients: [{ email: "user@example.com", varsJson: null }],
          }),
        );
        const db = yield* Database;
        const delivery = yield* db.get<{ id: string }>(
          "assert:delivery",
          "SELECT id FROM deliveries LIMIT 1;",
        );
        const token = signUnsubscribeToken(
          delivery?.id ?? "missing",
          fakeUnsubscribeConfig().currentSecret,
        );

        const unsubscribed = yield* unsubscribeByToken(token, "human");

        return {
          count: yield* db.get<{ count: number }>(
            "assert:suppressions",
            "SELECT count(*) AS count FROM suppressions;",
          ),
          unsubscribed,
        };
      }),
      { unsubscribe: Option.some(fakeUnsubscribeConfig()) },
    );

    expect(result.unsubscribed).toMatchObject({
      kind: "Success",
      appliedMarketingUnsubscribe: false,
    });
    expect(result.count).toEqual({ count: 0 });
  });

  it("distinguishes invalid tokens and valid expired links", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const token = signUnsubscribeToken(
          "missing_delivery",
          fakeUnsubscribeConfig().currentSecret,
        );
        const invalid = yield* unsubscribeByToken(`${token}x`, "human");
        const db = yield* Database;
        return {
          expired: yield* unsubscribeByToken(token, "human"),
          invalid,
          suppressions: yield* db.get<{ count: number }>(
            "assert:suppressions",
            "SELECT count(*) AS count FROM suppressions;",
          ),
        };
      }),
      { unsubscribe: Option.some(fakeUnsubscribeConfig()) },
    );

    expect(result).toEqual({
      expired: { kind: "Expired" },
      invalid: { kind: "Invalid" },
      suppressions: { count: 0 },
    });
  });
});
