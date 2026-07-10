import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { fakeUnsubscribeConfig, withTestApp, type FakeAuthBehavior } from "../testing/layers.ts";

function listRequest(
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
      new Request(`http://localhost/api/lists${path}`, {
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

describe("lists routes", () => {
  it("enforces auth and list API-key permissions", async () => {
    expect((await listRequest("", { auth: { session: null } })).status).toBe(401);
    expect(
      (
        await listRequest("", {
          auth: { apiKeyValid: false },
          headers: { "x-api-key": "invalid" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await listRequest("", {
          auth: { apiKeyPermissions: { lists: ["write"] } },
          headers: { "x-api-key": "valid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await listRequest("", {
          auth: { apiKeyPermissions: { lists: ["read"] } },
          headers: { "x-api-key": "valid" },
        })
      ).status,
    ).toBe(200);

    const writeDenied = await Promise.all(
      (
        [
          { body: { name: "Customers" }, method: "POST", path: "" },
          { body: { name: "Customers 2026" }, method: "PATCH", path: "/list_1" },
          {
            body: { contacts: [{ email: "user@example.com" }] },
            method: "POST",
            path: "/list_1/contacts",
          },
          { method: "DELETE", path: "/list_1/contacts/contact_1" },
          { method: "DELETE", path: "/list_1" },
        ] as const
      ).map((request) =>
        listRequest(request.path, {
          auth: { apiKeyPermissions: { lists: ["read"] } },
          body: "body" in request ? request.body : undefined,
          headers: { "x-api-key": "valid" },
          method: request.method,
        }),
      ),
    );
    expect(writeDenied.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
  });

  it("creates, lists, reads, updates, and deletes lists with counts", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      const create = await app.fetch(
        new Request("http://localhost/api/lists", {
          body: JSON.stringify({ name: " Customers " }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(create.status).toBe(201);
      await expect(create.json()).resolves.toMatchObject({
        list: { counts: { subscribed: 0, unsubscribed: 0 }, id: "id_1", name: "Customers" },
      });

      const update = await app.fetch(
        new Request("http://localhost/api/lists/id_1", {
          body: JSON.stringify({ name: "Customers 2026" }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        }),
      );
      expect(update.status).toBe(200);
      await expect(update.json()).resolves.toMatchObject({ list: { name: "Customers 2026" } });

      const list = await app.fetch(new Request("http://localhost/api/lists?limit=1&offset=0"));
      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        items: [{ id: "id_1", name: "Customers 2026" }],
        pagination: { limit: 1, nextOffset: null, offset: 0 },
      });

      const createSecond = await app.fetch(
        new Request("http://localhost/api/lists", {
          body: JSON.stringify({ name: "Prospects" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(createSecond.status).toBe(201);

      const probe = await app.fetch(new Request("http://localhost/api/lists?limit=1&offset=0"));
      expect(probe.status).toBe(200);
      await expect(probe.json()).resolves.toMatchObject({
        items: [{ id: "id_2", name: "Prospects" }],
        pagination: { limit: 1, nextOffset: 1, offset: 0 },
      });

      const detail = await app.fetch(new Request("http://localhost/api/lists/id_1"));
      expect(detail.status).toBe(200);
      await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.run(
            "test:list-suppression",
            `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
             VALUES ('supp_list', 'user@example.com', 'list', 'id_1', 'manual', '2026-07-03T12:00:00.000Z');`,
          ),
        ),
      );

      const deleted = await app.fetch(
        new Request("http://localhost/api/lists/id_1", { method: "DELETE" }),
      );
      expect(deleted.status).toBe(204);
      expect((await app.fetch(new Request("http://localhost/api/lists/id_1"))).status).toBe(404);
      const suppressionCount = await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.get<{ count: number }>(
            "test:list-suppression-count",
            "SELECT count(*) AS count FROM suppressions WHERE id = 'supp_list';",
          ),
        ),
      );
      expect(suppressionCount?.count).toBe(0);
    });
  });

  it("imports contacts idempotently, resubscribes, and does not remove marketing suppressions", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.run(
            "test:list",
            "INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Customers', '2026-07-03T12:00:00.000Z');",
          ),
        ),
      );

      const importOnce = await app.fetch(
        new Request("http://localhost/api/lists/list_1/contacts", {
          body: JSON.stringify({
            contacts: [
              { email: "A@Example.com" },
              { email: "a@example.com" },
              { email: "b@example.com" },
            ],
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(importOnce.status).toBe(200);
      await expect(importOnce.json()).resolves.toMatchObject({
        counts: {
          accepted: 2,
          alreadySubscribed: 0,
          contactsCreated: 2,
          membershipsCreated: 2,
          resubscribed: 0,
          submitted: 3,
        },
      });

      const unsubscribe = await app.fetch(
        new Request("http://localhost/api/lists/list_1/contacts/id_1", { method: "DELETE" }),
      );
      expect(unsubscribe.status).toBe(204);
      await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.run(
            "test:suppression",
            `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
             VALUES ('supp_1', 'a@example.com', 'marketing', NULL, 'unsubscribe', '2026-07-03T12:00:00.000Z');`,
          ),
        ),
      );

      const importAgain = await app.fetch(
        new Request("http://localhost/api/lists/list_1/contacts", {
          body: JSON.stringify({
            contacts: [{ email: "a@example.com" }, { email: "b@example.com" }],
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(importAgain.status).toBe(200);
      await expect(importAgain.json()).resolves.toMatchObject({
        counts: { accepted: 2, alreadySubscribed: 1, contactsCreated: 0, resubscribed: 1 },
        items: [
          { action: "resubscribed", email: "a@example.com", status: "subscribed" },
          { action: "already_subscribed", email: "b@example.com", status: "subscribed" },
        ],
      });

      const suppression = await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.get<{ count: number }>(
            "test:suppression-count",
            "SELECT count(*) AS count FROM suppressions WHERE email = 'a@example.com' AND scope = 'marketing';",
          ),
        ),
      );
      expect(suppression?.count).toBe(1);
    });
  });

  it("lists members with status/email/limit/offset filters and membership delete creates no suppression", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;
          yield* db.run(
            "test:list",
            "INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Customers', '2026-07-03T12:00:00.000Z');",
          );
          for (const [id, email, unsubscribed] of [
            ["c1", "a@example.com", null],
            ["c2", "b@example.com", "2026-07-03T12:02:00.000Z"],
            ["c3", "c@example.com", null],
          ] as const) {
            yield* db.run(
              `test:contact:${id}`,
              "INSERT INTO contacts (id, email, created_at, updated_at) VALUES ($id, $email, '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');",
              { email, id },
            );
            yield* db.run(
              `test:membership:${id}`,
              `INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at)
               VALUES ('list_1', $id, '2026-07-03T12:00:00.000Z', $unsubscribed);`,
              { id, unsubscribed },
            );
          }
        }),
      );

      const page = await app.fetch(
        new Request("http://localhost/api/lists/list_1/contacts?status=all&limit=1&offset=1"),
      );
      expect(page.status).toBe(200);
      await expect(page.json()).resolves.toMatchObject({
        items: [{ contact: { id: "c2" }, status: "unsubscribed" }],
        pagination: { limit: 1, nextOffset: 2, offset: 1 },
      });

      const exactFinal = await app.fetch(
        new Request("http://localhost/api/lists/list_1/contacts?status=all&limit=3&offset=0"),
      );
      expect(exactFinal.status).toBe(200);
      await expect(exactFinal.json()).resolves.toMatchObject({
        items: [{ contact: { id: "c1" } }, { contact: { id: "c2" } }, { contact: { id: "c3" } }],
        pagination: { limit: 3, nextOffset: null, offset: 0 },
      });

      const probe = await app.fetch(
        new Request("http://localhost/api/lists/list_1/contacts?status=all&limit=2&offset=0"),
      );
      expect(probe.status).toBe(200);
      await expect(probe.json()).resolves.toMatchObject({
        items: [{ contact: { id: "c1" } }, { contact: { id: "c2" } }],
        pagination: { limit: 2, nextOffset: 2, offset: 0 },
      });

      const filtered = await app.fetch(
        new Request("http://localhost/api/lists/list_1/contacts?email=C%40Example.com"),
      );
      expect(filtered.status).toBe(200);
      await expect(filtered.json()).resolves.toMatchObject({ items: [{ contact: { id: "c3" } }] });

      expect(
        (
          await app.fetch(
            new Request("http://localhost/api/lists/list_1/contacts/c3", { method: "DELETE" }),
          )
        ).status,
      ).toBe(204);
      const suppressions = await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.get<{ count: number }>(
            "test:suppression-count",
            "SELECT count(*) AS count FROM suppressions;",
          ),
        ),
      );
      expect(suppressions?.count).toBe(0);
    });
  });

  it("allows API-created lists to drive marketing mailings", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        unsubscribe: Option.some(fakeUnsubscribeConfig()),
      },
      async (app) => {
        expect(
          (
            await app.fetch(
              new Request("http://localhost/api/lists", {
                body: JSON.stringify({ name: "Customers" }),
                headers: { "content-type": "application/json" },
                method: "POST",
              }),
            )
          ).status,
        ).toBe(201);
        expect(
          (
            await app.fetch(
              new Request("http://localhost/api/lists/id_1/contacts", {
                body: JSON.stringify({ contacts: [{ email: "user@example.com" }] }),
                headers: { "content-type": "application/json" },
                method: "POST",
              }),
            )
          ).status,
        ).toBe(200);

        const mailing = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({
              html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
              listId: "id_1",
              purpose: "marketing",
              subject: "Hello",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        );
        expect(mailing.status).toBe(201);
        await expect(mailing.json()).resolves.toMatchObject({
          counts: { deliveries: 1, queued: 1, suppressed: 0 },
        });
      },
    );
  });
});
