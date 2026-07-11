import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { withTestApp, type FakeAuthBehavior, type TestRuntime } from "../testing/layers.ts";

function contactRequest(
  path: string,
  options: {
    auth: FakeAuthBehavior;
    body?: unknown;
    headers?: Record<string, string>;
    method?: string;
  },
): Promise<Response> {
  return withTestApp({ auth: options.auth }, async (app) =>
    app.fetch(
      new Request(`http://localhost/api/contacts${path}`, {
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        headers:
          options.body === undefined
            ? options.headers
            : { "content-type": "application/json", ...(options.headers ?? {}) },
        method: options.method ?? "GET",
      }),
    ),
  );
}

async function seedContactScenario(runtime: TestRuntime): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "test:list",
        "INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Customers', '2026-07-03T12:00:00.000Z');",
      );
      yield* db.run(
        "test:contact",
        `INSERT INTO contacts (id, email, created_at, updated_at)
         VALUES ('contact_1', 'User@Example.com', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');`,
      );
      yield* db.run(
        "test:membership",
        `INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at)
         VALUES ('list_1', 'contact_1', '2026-07-03T12:00:00.000Z', NULL);`,
      );
      yield* db.run(
        "test:suppression",
        `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
         VALUES ('supp_1', 'user@example.com', 'all', NULL, 'manual', '2026-07-03T12:00:00.000Z');`,
      );
      yield* db.run(
        "test:mailing",
        `INSERT INTO mailings (id, purpose, state, subject, html, created_at, updated_at)
         VALUES ('mailing_1', 'transactional', 'completed', 'Hi', '<p>Hi</p>', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');`,
      );
      yield* db.run(
        "test:delivery",
        `INSERT INTO deliveries (id, mailing_id, email, contact_id, status, created_at, updated_at)
         VALUES ('delivery_1', 'mailing_1', 'user@example.com', 'contact_1', 'sent', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');`,
      );
    }),
  );
}

describe("contacts routes", () => {
  it("enforces auth and contact API-key permissions", async () => {
    const noAuth = await contactRequest("", { auth: { session: null } });
    expect(noAuth.status).toBe(401);

    const invalidKey = await contactRequest("", {
      auth: { apiKeyValid: false },
      headers: { "x-api-key": "invalid" },
    });
    expect(invalidKey.status).toBe(401);

    const missingPermission = await contactRequest("", {
      auth: { apiKeyPermissions: { contacts: ["write"] } },
      headers: { "x-api-key": "valid" },
    });
    expect(missingPermission.status).toBe(403);

    const canRead = await contactRequest("", {
      auth: { apiKeyPermissions: { contacts: ["read"] } },
      headers: { "x-api-key": "valid" },
    });
    expect(canRead.status).toBe(200);

    const writeDenied = await Promise.all(
      (
        [
          { body: { email: "user@example.com" }, method: "POST", path: "" },
          { body: { email: "new@example.com" }, method: "PATCH", path: "/contact_1" },
          { method: "DELETE", path: "/contact_1" },
        ] as const
      ).map((request) =>
        contactRequest(request.path, {
          auth: { apiKeyPermissions: { contacts: ["read"] } },
          body: "body" in request ? request.body : undefined,
          headers: { "x-api-key": "valid" },
          method: request.method,
        }),
      ),
    );
    expect(writeDenied.map((response) => response.status)).toEqual([403, 403, 403]);

    const session = await contactRequest("", { auth: { session: { userId: "user_1" } } });
    expect(session.status).toBe(200);
  });

  it("returns 404 for get/patch/delete of an unknown contact", async () => {
    const auth = { session: { userId: "user_1" } };
    const get = await contactRequest("/missing_1", { auth });
    expect(get.status).toBe(404);
    const patch = await contactRequest("/missing_1", {
      auth,
      body: { email: "new@example.com" },
      method: "PATCH",
    });
    expect(patch.status).toBe(404);
    const del = await contactRequest("/missing_1", { auth, method: "DELETE" });
    expect(del.status).toBe(404);
  });

  it("creates normalized contacts and returns existing duplicates", async () => {
    await withTestApp({ auth: { apiKeyPermissions: { contacts: ["write"] } } }, async (app) => {
      const create = (email: string) =>
        app.fetch(
          new Request("http://localhost/api/contacts", {
            body: JSON.stringify({ email }),
            headers: { "content-type": "application/json", "x-api-key": "valid" },
            method: "POST",
          }),
        );

      const first = await create(" User@Example.com ");
      expect(first.status).toBe(201);
      await expect(first.json()).resolves.toMatchObject({
        contact: { email: "user@example.com", id: "id_1" },
        created: true,
      });

      const duplicate = await create("user@example.com");
      expect(duplicate.status).toBe(200);
      await expect(duplicate.json()).resolves.toMatchObject({
        contact: { email: "user@example.com", id: "id_1" },
        created: false,
      });
    });
  });

  it("lists contacts with email filter, limit, and offset", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          Effect.all([
            db.run(
              "test:c1",
              "INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('c1', 'a@example.com', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');",
            ),
            db.run(
              "test:c2",
              "INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('c2', 'b@example.com', '2026-07-03T12:01:00.000Z', '2026-07-03T12:01:00.000Z');",
            ),
            db.run(
              "test:c3",
              "INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('c3', 'c@example.com', '2026-07-03T12:02:00.000Z', '2026-07-03T12:02:00.000Z');",
            ),
          ]),
        ),
      );

      const page = await app.fetch(new Request("http://localhost/api/contacts?limit=1&offset=1"));
      expect(page.status).toBe(200);
      await expect(page.json()).resolves.toMatchObject({
        items: [{ id: "c2" }],
        pagination: { limit: 1, nextOffset: 2, offset: 1 },
      });

      const exactFinal = await app.fetch(
        new Request("http://localhost/api/contacts?limit=3&offset=0"),
      );
      expect(exactFinal.status).toBe(200);
      await expect(exactFinal.json()).resolves.toMatchObject({
        items: [{ id: "c3" }, { id: "c2" }, { id: "c1" }],
        pagination: { limit: 3, nextOffset: null, offset: 0 },
      });

      const probe = await app.fetch(new Request("http://localhost/api/contacts?limit=2&offset=0"));
      expect(probe.status).toBe(200);
      await expect(probe.json()).resolves.toMatchObject({
        items: [{ id: "c3" }, { id: "c2" }],
        pagination: { limit: 2, nextOffset: 2, offset: 0 },
      });

      const filtered = await app.fetch(
        new Request("http://localhost/api/contacts?email=B%40Example.com"),
      );
      expect(filtered.status).toBe(200);
      await expect(filtered.json()).resolves.toMatchObject({ items: [{ id: "c2" }] });
    });
  });

  it("reads detail with memberships and updates with conflict/no-op behavior", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await seedContactScenario(runtime);
      await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.run(
            "test:other-contact",
            "INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('contact_2', 'other@example.com', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');",
          ),
        ),
      );

      const detail = await app.fetch(new Request("http://localhost/api/contacts/contact_1"));
      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        contact: { email: "user@example.com", id: "contact_1" },
        memberships: [{ listId: "list_1", listName: "Customers", status: "subscribed" }],
      });

      const noop = await app.fetch(
        new Request("http://localhost/api/contacts/contact_1", {
          body: JSON.stringify({ email: "USER@example.com" }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        }),
      );
      expect(noop.status).toBe(200);

      const conflict = await app.fetch(
        new Request("http://localhost/api/contacts/contact_1", {
          body: JSON.stringify({ email: "other@example.com" }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        }),
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({
        error: { code: "conflict", message: "Another contact already uses this email." },
      });
    });
  });

  it("updates contact email without rewriting delivery snapshots or suppressions", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await seedContactScenario(runtime);

      const update = await app.fetch(
        new Request("http://localhost/api/contacts/contact_1", {
          body: JSON.stringify({ email: "new@example.com" }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        }),
      );
      expect(update.status).toBe(200);
      await expect(update.json()).resolves.toMatchObject({
        contact: { email: "new@example.com", id: "contact_1" },
      });

      const state = await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;
          return {
            delivery: yield* db.get<{ contactId: string | null; email: string }>(
              "test:update-delivery-snapshot",
              "SELECT contact_id AS contactId, email FROM deliveries WHERE id = 'delivery_1';",
            ),
            newEmailSuppressions: yield* db.get<{ count: number }>(
              "test:update-new-suppression-count",
              "SELECT count(*) AS count FROM suppressions WHERE email = 'new@example.com';",
            ),
            oldEmailSuppressions: yield* db.get<{ count: number }>(
              "test:update-old-suppression-count",
              "SELECT count(*) AS count FROM suppressions WHERE email = 'user@example.com';",
            ),
          };
        }),
      );

      expect(state.delivery).toEqual({ contactId: "contact_1", email: "user@example.com" });
      expect(state.oldEmailSuppressions?.count).toBe(1);
      expect(state.newEmailSuppressions?.count).toBe(0);
    });
  });

  it("deletes contacts while preserving delivery snapshots and suppressions", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await seedContactScenario(runtime);

      const deleted = await app.fetch(
        new Request("http://localhost/api/contacts/contact_1", { method: "DELETE" }),
      );
      expect(deleted.status).toBe(204);

      const state = await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;
          return {
            delivery: yield* db.get<{ contactId: string | null; email: string }>(
              "test:delivery",
              "SELECT contact_id AS contactId, email FROM deliveries WHERE id = 'delivery_1';",
            ),
            memberships: yield* db.get<{ count: number }>(
              "test:memberships",
              "SELECT count(*) AS count FROM list_memberships;",
            ),
            suppressions: yield* db.get<{ count: number }>(
              "test:suppressions",
              "SELECT count(*) AS count FROM suppressions WHERE email = 'user@example.com';",
            ),
          };
        }),
      );

      expect(state.delivery).toEqual({ contactId: null, email: "user@example.com" });
      expect(state.memberships?.count).toBe(0);
      expect(state.suppressions?.count).toBe(1);
    });
  });
});
