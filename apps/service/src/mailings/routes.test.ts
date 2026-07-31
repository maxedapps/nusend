// Frozen envelopes (status codes, error.code values, auth messages) asserted
// 1:1 from the pre-Effect scenarios. Validation message prose is Schema-derived
// now, so those cases assert status + code only.
import {
  CreateMailingRequestSchema,
  CreateMailingResponseSchema,
  MailingDetailResponseSchema,
  MailingsListResponseSchema,
} from "@nusend/api-contract";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import {
  fakeUnsubscribeConfig,
  withTestApp,
  type FakeAuthBehavior,
  type TestRuntime,
} from "../testing/layers.ts";
import { maxIdempotencyKeyLength } from "./idempotency.ts";
import { maxMailingHtmlLength, maxMailingRequestBodyBytes } from "./schema.ts";

const validBody = {
  html: "<p>Hello</p>",
  purpose: "transactional",
  recipients: [{ email: "user@example.com" }],
  subject: "Hello",
};

function postMailing(
  auth: FakeAuthBehavior,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return withTestApp({ auth }, async (app) =>
    app.fetch(
      new Request("http://localhost/api/mailings", {
        body: options.body ?? JSON.stringify(validBody),
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
        method: "POST",
      }),
    ),
  );
}

function countRows(runtime: TestRuntime) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const count = (table: string) =>
        Effect.map(
          db.get<{ count: number }>("count", `SELECT count(*) AS count FROM ${table};`),
          (row) => row?.count,
        );

      return {
        deliveries: yield* count("deliveries"),
        idempotencyKeys: yield* count("mailing_idempotency_keys"),
        jobs: yield* count("jobs"),
        mailings: yield* count("mailings"),
      };
    }),
  );
}

describe("mailings routes", () => {
  it("enforces auth and API-key permissions", async () => {
    const noAuth = await postMailing({ session: null });
    expect(noAuth.status).toBe(401);
    await expect(noAuth.json()).resolves.toEqual({
      error: { code: "unauthenticated", message: "Authentication required." },
    });

    const invalidKey = await postMailing(
      { apiKeyValid: false },
      { headers: { "x-api-key": "invalid" } },
    );
    expect(invalidKey.status).toBe(401);
    await expect(invalidKey.json()).resolves.toEqual({
      error: { code: "unauthenticated", message: "Invalid API key." },
    });

    const missingPermission = await postMailing(
      { apiKeyPermissions: { mailings: ["read"] } },
      { headers: { "x-api-key": "valid" } },
    );
    expect(missingPermission.status).toBe(403);
    await expect(missingPermission.json()).resolves.toEqual({
      error: { code: "forbidden", message: "API key does not have the required permissions." },
    });
  });

  it("creates a mailing with a valid API key", async () => {
    await withTestApp(
      { auth: { apiKeyPermissions: { mailings: ["write"] } } },
      async (app, runtime) => {
        const response = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify(validBody),
            headers: { "content-type": "application/json", "x-api-key": "valid" },
            method: "POST",
          }),
        );

        expect(response.status).toBe(201);
        expect(() => Schema.decodeUnknownSync(CreateMailingRequestSchema)(validBody)).not.toThrow();
        const json = (await response.json()) as {
          counts: unknown;
          mailing: { id: unknown; purpose: string; scheduledAt: unknown; state: string };
        };
        expect(() => Schema.decodeUnknownSync(CreateMailingResponseSchema)(json)).not.toThrow();
        expect(json.mailing.purpose).toBe("transactional");
        expect(json.mailing.state).toBe("scheduled");
        expect(json.counts).toEqual({ deliveries: 1, queued: 1, suppressed: 0 });
        expect(typeof json.mailing.id).toBe("string");
        expect(typeof json.mailing.scheduledAt).toBe("string");
        await expect(countRows(runtime)).resolves.toEqual({
          deliveries: 1,
          idempotencyKeys: 0,
          jobs: 1,
          mailings: 1,
        });
      },
    );
  });

  it("rejects marketing mailings without unsubscribe configuration", async () => {
    await withTestApp(
      { auth: { apiKeyPermissions: { mailings: ["write"] } } },
      async (app, runtime) => {
        const response = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({
              ...validBody,
              html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
              purpose: "marketing",
            }),
            headers: { "content-type": "application/json", "x-api-key": "valid" },
            method: "POST",
          }),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "invalid_request",
            message: "Marketing mailings require unsubscribe configuration.",
          },
        });
        await expect(countRows(runtime)).resolves.toEqual({
          deliveries: 0,
          idempotencyKeys: 0,
          jobs: 0,
          mailings: 0,
        });
      },
    );
  });

  it("rejects marketing mailings missing the unsubscribe URL placeholder", async () => {
    await withTestApp(
      {
        auth: { apiKeyPermissions: { mailings: ["write"] } },
        unsubscribe: Option.some(fakeUnsubscribeConfig()),
      },
      async (app, runtime) => {
        const response = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({ ...validBody, purpose: "marketing" }),
            headers: { "content-type": "application/json", "x-api-key": "valid" },
            method: "POST",
          }),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "invalid_request",
            message: "Marketing mailings must include {{ unsubscribe.url }} in the HTML template.",
          },
        });
        await expect(countRows(runtime)).resolves.toEqual({
          deliveries: 0,
          idempotencyKeys: 0,
          jobs: 0,
          mailings: 0,
        });
      },
    );
  });

  it("creates a marketing mailing when unsubscribe configuration and placeholder are present", async () => {
    await withTestApp(
      {
        auth: { apiKeyPermissions: { mailings: ["write"] } },
        unsubscribe: Option.some(fakeUnsubscribeConfig()),
      },
      async (app, runtime) => {
        const response = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({
              ...validBody,
              html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
              purpose: "marketing",
            }),
            headers: { "content-type": "application/json", "x-api-key": "valid" },
            method: "POST",
          }),
        );

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toMatchObject({
          counts: { deliveries: 1, queued: 1, suppressed: 0 },
          mailing: { purpose: "marketing", state: "scheduled" },
        });
        await expect(countRows(runtime)).resolves.toEqual({
          deliveries: 1,
          idempotencyKeys: 0,
          jobs: 1,
          mailings: 1,
        });
      },
    );
  });

  it("creates a mailing with a valid session principal", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      const response = await app.fetch(
        new Request("http://localhost/api/mailings", {
          body: JSON.stringify(validBody),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );

      expect(response.status).toBe(201);
      const json = (await response.json()) as { counts: unknown };
      expect(json.counts).toEqual({ deliveries: 1, queued: 1, suppressed: 0 });
      await expect(countRows(runtime)).resolves.toEqual({
        deliveries: 1,
        idempotencyKeys: 0,
        jobs: 1,
        mailings: 1,
      });
    });
  });

  it("replays same-key idempotent creates without duplicate rows", async () => {
    await withTestApp(
      { auth: { apiKeyPermissions: { mailings: ["write"] } } },
      async (app, runtime) => {
        const request = () =>
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify(validBody),
            headers: {
              "content-type": "application/json",
              "idempotency-key": "create-1",
              "x-api-key": "valid",
            },
            method: "POST",
          });

        const first = await app.fetch(request());
        const firstJson = await first.json();
        expect(first.status).toBe(201);

        await runtime.runPromise(
          Effect.flatMap(Database, (db) =>
            db.run(
              "test:mutate-delivery-status",
              "UPDATE deliveries SET status = 'sent', ses_message_id = 'ses_1';",
            ),
          ),
        );

        const second = await app.fetch(request());
        expect(second.status).toBe(201);
        await expect(second.json()).resolves.toEqual(firstJson);
        await expect(countRows(runtime)).resolves.toEqual({
          deliveries: 1,
          idempotencyKeys: 1,
          jobs: 1,
          mailings: 1,
        });
      },
    );
  });

  it("normalizes equivalent wire scheduledAt values before idempotency hashing", async () => {
    await withTestApp(
      { auth: { apiKeyPermissions: { mailings: ["write"] } } },
      async (app, runtime) => {
        const create = (scheduledAt: string) =>
          app.fetch(
            new Request("http://localhost/api/mailings", {
              body: JSON.stringify({ ...validBody, scheduledAt }),
              headers: {
                "content-type": "application/json",
                "idempotency-key": "scheduled-at-normalization",
                "x-api-key": "valid",
              },
              method: "POST",
            }),
          );

        const first = await create("2030-01-01T00:00:00Z");
        const firstJson = await first.json();
        const replay = await create("2030-01-01T00:00:00.000Z");
        expect(first.status).toBe(201);
        expect(replay.status).toBe(201);
        await expect(replay.json()).resolves.toEqual(firstJson);
        await expect(countRows(runtime)).resolves.toEqual({
          deliveries: 1,
          idempotencyKeys: 1,
          jobs: 1,
          mailings: 1,
        });
        const stored = await runtime.runPromise(
          Effect.flatMap(Database, (db) =>
            db.get<{ scheduledAt: string }>(
              "test:scheduled-at",
              "SELECT scheduled_at AS scheduledAt FROM mailings;",
            ),
          ),
        );
        expect(stored).toEqual({ scheduledAt: "2030-01-01T00:00:00.000Z" });

        const conflict = await create("2030-01-01T00:00:00.001Z");
        expect(conflict.status).toBe(409);
        await expect(conflict.json()).resolves.toMatchObject({
          error: { code: "idempotency_conflict" },
        });
      },
    );
  });

  it("rejects same-key creates with a different normalized request", async () => {
    await withTestApp(
      { auth: { apiKeyPermissions: { mailings: ["write"] } } },
      async (app, runtime) => {
        const create = (body: unknown) =>
          app.fetch(
            new Request("http://localhost/api/mailings", {
              body: JSON.stringify(body),
              headers: {
                "content-type": "application/json",
                "idempotency-key": "create-conflict",
                "x-api-key": "valid",
              },
              method: "POST",
            }),
          );

        expect((await create(validBody)).status).toBe(201);
        const conflict = await create({ ...validBody, subject: "Different" });

        expect(conflict.status).toBe(409);
        await expect(conflict.json()).resolves.toEqual({
          error: {
            code: "idempotency_conflict",
            message: "Idempotency key was already used for a different request.",
          },
        });
        await expect(countRows(runtime)).resolves.toEqual({
          deliveries: 1,
          idempotencyKeys: 1,
          jobs: 1,
          mailings: 1,
        });
      },
    );
  });

  it.each([
    {
      body: { ...validBody, listId: "list_1", recipients: null },
      message: "Provide exactly one recipient source: recipients or listId.",
      name: "counts null recipients as a present source before structural decoding",
    },
    {
      body: { html: "<p>Hello</p>", purpose: "marketing", subject: "Hello" },
      message: "Provide exactly one recipient source: recipients or listId.",
      name: "rejects a missing recipient source",
    },
    {
      body: {
        html: "<p>Hello</p>",
        listId: "list_1",
        purpose: "transactional",
        subject: "Hello",
      },
      message: "Transactional mailings must use recipients and cannot use listId.",
      name: "rejects transactional list sources",
    },
  ])("$name", async ({ body, message }) => {
    const response = await postMailing(
      { apiKeyPermissions: { mailings: ["write"] } },
      { body: JSON.stringify(body), headers: { "x-api-key": "valid" } },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message },
    });
  });

  it("rejects oversized idempotency keys", async () => {
    const response = await postMailing(
      { apiKeyPermissions: { mailings: ["write"] } },
      {
        headers: {
          "idempotency-key": "x".repeat(maxIdempotencyKeyLength + 1),
          "x-api-key": "valid",
        },
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: `Idempotency-Key must be at most ${maxIdempotencyKeyLength} characters.`,
      },
    });
  });

  it.each([[""], ["   "]])("rejects a blank idempotency key %j", async (idempotencyKey) => {
    const response = await postMailing(
      { apiKeyPermissions: { mailings: ["write"] } },
      { headers: { "idempotency-key": idempotencyKey, "x-api-key": "valid" } },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Idempotency-Key must not be blank." },
    });
  });

  it("creates a mailing when the idempotency key header is omitted", async () => {
    const response = await postMailing(
      { apiKeyPermissions: { mailings: ["write"] } },
      { headers: { "x-api-key": "valid" } },
    );

    expect(response.status).toBe(201);
  });

  it("rejects oversized request bodies before parsing", async () => {
    const response = await postMailing(
      { apiKeyPermissions: { mailings: ["write"] } },
      {
        body: JSON.stringify({ payload: "x".repeat(maxMailingRequestBodyBytes + 1) }),
        headers: { "x-api-key": "valid" },
      },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "request_too_large", message: "Request body is too large." },
    });
  });

  it("maps malformed JSON, invalid payloads, missing lists, and empty recipient sets", async () => {
    const canCreate: FakeAuthBehavior = { apiKeyPermissions: { mailings: ["write"] } };
    const keyHeaders = { headers: { "x-api-key": "valid" } };

    const malformed = await postMailing(canCreate, { body: "{", ...keyHeaders });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Request body must be valid JSON." },
    });

    const invalid = await postMailing(canCreate, {
      body: JSON.stringify({ ...validBody, subject: "" }),
      ...keyHeaders,
    });
    expect(invalid.status).toBe(400);
    const invalidJson = (await invalid.json()) as { error: { code: string } };
    expect(invalidJson.error.code).toBe("invalid_request");

    const oversizedField = await postMailing(canCreate, {
      body: JSON.stringify({ ...validBody, html: "x".repeat(maxMailingHtmlLength + 1) }),
      ...keyHeaders,
    });
    expect(oversizedField.status).toBe(400);
    const oversizedJson = (await oversizedField.json()) as { error: { code: string } };
    expect(oversizedJson.error.code).toBe("invalid_request");

    await withTestApp(
      { auth: canCreate, unsubscribe: Option.some(fakeUnsubscribeConfig()) },
      async (app) => {
        const missingList = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({
              html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
              listId: "missing",
              purpose: "marketing",
              subject: "Hello",
            }),
            headers: { "content-type": "application/json", "x-api-key": "valid" },
            method: "POST",
          }),
        );
        expect(missingList.status).toBe(404);
        await expect(missingList.json()).resolves.toEqual({
          error: { code: "not_found", message: "List not found." },
        });
      },
    );

    await withTestApp({ auth: canCreate }, async (app, runtime) => {
      await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.run(
            "seed:suppression",
            `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
             VALUES ('sup_1', 'user@example.com', 'all', NULL, 'manual', $now);`,
            { now: "2026-07-03T12:00:00.000Z" },
          ),
        ),
      );

      const suppressed = await app.fetch(
        new Request("http://localhost/api/mailings", {
          body: JSON.stringify(validBody),
          headers: { "content-type": "application/json", "x-api-key": "valid" },
          method: "POST",
        }),
      );

      expect(suppressed.status).toBe(422);
      await expect(suppressed.json()).resolves.toEqual({
        error: {
          code: "empty_recipient_set",
          message: "Mailing has no sendable recipients after suppression checks.",
        },
      });
    });
  });
});

describe("mailings read routes", () => {
  it("enforces read auth for unauthenticated, scoped-key, and session principals", async () => {
    await withTestApp({ auth: { session: null } }, async (app) => {
      expect((await app.fetch(new Request("http://localhost/api/mailings"))).status).toBe(401);
    });

    await withTestApp({ auth: { apiKeyPermissions: { mailings: ["write"] } } }, async (app) => {
      const response = await app.fetch(
        new Request("http://localhost/api/mailings", {
          headers: { "x-api-key": "valid" },
        }),
      );
      expect(response.status).toBe(403);
    });

    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app) => {
      expect((await app.fetch(new Request("http://localhost/api/mailings"))).status).toBe(200);
    });
  });

  it("lists and reads mailings through a real read-scoped key", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["key_1"],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedMailingsReadScenario(runtime);
        const keyResponse = await app.fetch(
          new Request("http://localhost/api/api-keys", {
            body: JSON.stringify({
              name: "mailings-reader",
              permissions: { mailings: ["read"] },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        );
        expect(keyResponse.status).toBe(201);
        const key = ((await keyResponse.json()) as { apiKey: { key: string } }).apiKey.key;
        const headers = { "x-api-key": key };

        const list = await app.fetch(
          new Request("http://localhost/api/mailings?limit=1&offset=0", { headers }),
        );
        expect(list.status).toBe(200);
        const listBody = await list.json();
        expect(() => Schema.decodeUnknownSync(MailingsListResponseSchema)(listBody)).not.toThrow();
        expect(listBody).toMatchObject({
          items: [
            {
              counts: {
                ambiguous: 1,
                failed: 1,
                queued: 1,
                sending: 1,
                sent: 2,
                suppressed: 1,
              },
              id: "mailing_1",
              subject: "Newest",
            },
          ],
          pagination: { limit: 1, nextOffset: 1, offset: 0 },
        });
        expect(JSON.stringify(listBody)).not.toContain("<p>private body</p>");
        expect(JSON.stringify(listBody)).not.toContain("plain private body");
        expect(JSON.stringify(listBody)).not.toContain("recipient-secret");

        const finalPage = await app.fetch(
          new Request("http://localhost/api/mailings?limit=1&offset=1", { headers }),
        );
        await expect(finalPage.json()).resolves.toMatchObject({
          items: [{ id: "mailing_2" }],
          pagination: { limit: 1, nextOffset: null, offset: 1 },
        });

        const detail = await app.fetch(
          new Request("http://localhost/api/mailings/mailing_1", { headers }),
        );
        expect(detail.status).toBe(200);
        const detailBody = await detail.json();
        expect(() =>
          Schema.decodeUnknownSync(MailingDetailResponseSchema)(detailBody),
        ).not.toThrow();
        expect(detailBody).toMatchObject({
          mailing: {
            counts: {
              ambiguous: 1,
              failed: 1,
              queued: 1,
              sending: 1,
              sent: 2,
              suppressed: 1,
            },
            html: "<p>private body</p>",
            id: "mailing_1",
            text: "plain private body",
          },
        });
        expect(JSON.stringify(detailBody)).not.toContain("recipient-secret");

        const missing = await app.fetch(
          new Request("http://localhost/api/mailings/missing", { headers }),
        );
        expect(missing.status).toBe(404);
      },
    );
  });
});

async function seedMailingsReadScenario(runtime: TestRuntime): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "mailingsReadTest:user",
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES ('user_1', 'Max', 'max@example.com', 1, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');`,
      );
      yield* db.run(
        "mailingsReadTest:mailing1",
        `INSERT INTO mailings (id, purpose, state, name, subject, html, text, list_id, scheduled_at, created_at, updated_at)
         VALUES ('mailing_1', 'transactional', 'completed', 'Newest mailing', 'Newest', '<p>private body</p>', 'plain private body', NULL, NULL, '2026-07-09T12:00:00.000Z', '2026-07-09T12:01:00.000Z');`,
      );
      yield* db.run(
        "mailingsReadTest:mailing2",
        `INSERT INTO mailings (id, purpose, state, name, subject, html, text, list_id, scheduled_at, created_at, updated_at)
         VALUES ('mailing_2', 'marketing', 'scheduled', NULL, 'Older', '<p>older</p>', NULL, NULL, '2026-07-10T12:00:00.000Z', '2026-07-08T12:00:00.000Z', '2026-07-08T12:00:00.000Z');`,
      );

      const statuses = ["queued", "sending", "sent", "sent", "failed", "suppressed", "ambiguous"];
      yield* Effect.forEach(statuses, (status, index) =>
        db.run(
          `mailingsReadTest:delivery:${index}`,
          `INSERT INTO deliveries (id, mailing_id, email, vars_json, status, created_at, updated_at)
           VALUES ($id, 'mailing_1', $email, $varsJson, $status, '2026-07-09T12:00:00.000Z', '2026-07-09T12:00:00.000Z');`,
          {
            email: `user${index}@example.com`,
            id: `delivery_${index}`,
            status,
            varsJson: index === 0 ? '{"secret":"recipient-secret"}' : null,
          },
        ),
      );
    }),
  );
}
