// Frozen envelopes (status codes, error.code values, auth messages) asserted
// 1:1 from the pre-Effect scenarios. Validation message prose is Schema-derived
// now, so those cases assert status + code only.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { withTestApp, type FakeAuthBehavior, type TestRuntime } from "../testing/layers.ts";
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
      { auth: { apiKeyPermissions: { mailings: ["create"] } } },
      async (app, runtime) => {
        const response = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify(validBody),
            headers: { "content-type": "application/json", "x-api-key": "valid" },
            method: "POST",
          }),
        );

        expect(response.status).toBe(201);
        const json = (await response.json()) as {
          counts: unknown;
          mailing: { id: unknown; purpose: string; scheduledAt: unknown; state: string };
        };
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
      { auth: { apiKeyPermissions: { mailings: ["create"] } } },
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

  it("rejects same-key creates with a different normalized request", async () => {
    await withTestApp(
      { auth: { apiKeyPermissions: { mailings: ["create"] } } },
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

  it("rejects oversized idempotency keys", async () => {
    const response = await postMailing(
      { apiKeyPermissions: { mailings: ["create"] } },
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

  it("rejects oversized request bodies before parsing", async () => {
    const response = await postMailing(
      { apiKeyPermissions: { mailings: ["create"] } },
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
    const canCreate: FakeAuthBehavior = { apiKeyPermissions: { mailings: ["create"] } };
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

    const missingList = await postMailing(canCreate, {
      body: JSON.stringify({
        html: "<p>Hello</p>",
        listId: "missing",
        purpose: "marketing",
        subject: "Hello",
      }),
      ...keyHeaders,
    });
    expect(missingList.status).toBe(404);
    await expect(missingList.json()).resolves.toEqual({
      error: { code: "not_found", message: "List not found." },
    });

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
