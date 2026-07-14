import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { fakeUnsubscribeConfig, withTestApp, type FakeAuthBehavior } from "../testing/layers.ts";
import { upsertAutomatedSuppression } from "./write.ts";

function suppressionRequest(
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
      new Request(`http://localhost/api/suppressions${path}`, {
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

describe("suppressions routes", () => {
  it("enforces auth and suppression API-key permissions", async () => {
    expect((await suppressionRequest("", { auth: { session: null } })).status).toBe(401);
    expect(
      (
        await suppressionRequest("", {
          auth: { apiKeyValid: false },
          headers: { "x-api-key": "invalid" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await suppressionRequest("", {
          auth: { apiKeyPermissions: { suppressions: ["write"] } },
          headers: { "x-api-key": "valid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await suppressionRequest("", {
          auth: { apiKeyPermissions: { suppressions: ["read"] } },
          headers: { "x-api-key": "valid" },
        })
      ).status,
    ).toBe(200);

    const writeDenied = await Promise.all(
      (
        [
          { body: { email: "user@example.com", scope: "all" }, method: "POST", path: "" },
          { method: "DELETE", path: "/supp_1" },
        ] as const
      ).map((request) =>
        suppressionRequest(request.path, {
          auth: { apiKeyPermissions: { suppressions: ["read"] } },
          body: "body" in request ? request.body : undefined,
          headers: { "x-api-key": "valid" },
          method: request.method,
        }),
      ),
    );
    expect(writeDenied.map((response) => response.status)).toEqual([403, 403]);
  });

  it("creates all, marketing, and list suppressions with validation", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.run(
            "test:list",
            "INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Customers', '2026-07-03T12:00:00.000Z');",
          ),
        ),
      );

      const createSuppression = async (body: { email: string; listId?: string; scope: string }) => {
        const response = await app.fetch(
          new Request("http://localhost/api/suppressions", {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        );
        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toMatchObject({
          suppression: {
            email: body.email.toLowerCase(),
            reason: "manual",
            scope: body.scope,
          },
          created: true,
        });
      };

      await createSuppression({ email: "All@Example.com", scope: "all" });
      await createSuppression({ email: "Marketing@Example.com", scope: "marketing" });
      await createSuppression({ email: "List@Example.com", listId: "list_1", scope: "list" });

      expect(
        (
          await app.fetch(
            new Request("http://localhost/api/suppressions", {
              body: JSON.stringify({ email: "bad@example.com", scope: "all", listId: "list_1" }),
              headers: { "content-type": "application/json" },
              method: "POST",
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await app.fetch(
            new Request("http://localhost/api/suppressions", {
              body: JSON.stringify({ email: "bad@example.com", scope: "list", listId: "missing" }),
              headers: { "content-type": "application/json" },
              method: "POST",
            }),
          )
        ).status,
      ).toBe(404);
    });
  });

  it("returns existing duplicate suppressions without rewriting automated reasons", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.run(
            "test:bounce",
            `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
             VALUES ('supp_bounce', 'bounce@example.com', 'all', NULL, 'bounce', '2026-07-03T12:00:00.000Z');`,
          ),
        ),
      );

      const duplicate = await app.fetch(
        new Request("http://localhost/api/suppressions", {
          body: JSON.stringify({ email: "Bounce@Example.com", scope: "all" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(duplicate.status).toBe(200);
      await expect(duplicate.json()).resolves.toMatchObject({
        created: false,
        suppression: { id: "supp_bounce", reason: "bounce" },
      });
    });
  });

  it("lists suppressions with filters and pagination", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;
          yield* db.run(
            "test:list",
            "INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Customers', '2026-07-03T12:00:00.000Z');",
          );
          for (const [id, email, scope, listId, reason, createdAt] of [
            ["s1", "a@example.com", "all", null, "manual", "2026-07-03T12:00:00.000Z"],
            ["s2", "b@example.com", "marketing", null, "manual", "2026-07-03T12:01:00.000Z"],
            ["s3", "c@example.com", "list", "list_1", "manual", "2026-07-03T12:02:00.000Z"],
          ] as const) {
            yield* db.run(
              `test:supp:${id}`,
              `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
               VALUES ($id, $email, $scope, $listId, $reason, $createdAt);`,
              { createdAt, email, id, listId, reason, scope },
            );
          }
        }),
      );

      const page = await app.fetch(
        new Request("http://localhost/api/suppressions?limit=1&offset=1"),
      );
      expect(page.status).toBe(200);
      await expect(page.json()).resolves.toMatchObject({
        items: [{ id: "s2" }],
        pagination: { limit: 1, nextOffset: 2, offset: 1 },
      });

      const exactFinal = await app.fetch(
        new Request("http://localhost/api/suppressions?limit=3&offset=0"),
      );
      expect(exactFinal.status).toBe(200);
      await expect(exactFinal.json()).resolves.toMatchObject({
        items: [{ id: "s3" }, { id: "s2" }, { id: "s1" }],
        pagination: { limit: 3, nextOffset: null, offset: 0 },
      });

      const probe = await app.fetch(
        new Request("http://localhost/api/suppressions?limit=2&offset=0"),
      );
      expect(probe.status).toBe(200);
      await expect(probe.json()).resolves.toMatchObject({
        items: [{ id: "s3" }, { id: "s2" }],
        pagination: { limit: 2, nextOffset: 2, offset: 0 },
      });

      const filtered = await app.fetch(
        new Request(
          "http://localhost/api/suppressions?scope=list&listId=list_1&email=C%40Example.com&reason=manual",
        ),
      );
      expect(filtered.status).toBe(200);
      await expect(filtered.json()).resolves.toMatchObject({ items: [{ id: "s3" }] });
    });
  });

  it("deletes only manual suppressions", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app, runtime) => {
      await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          Effect.all([
            db.run(
              "test:manual",
              `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
               VALUES ('manual_1', 'manual@example.com', 'all', NULL, 'manual', '2026-07-03T12:00:00.000Z');`,
            ),
            db.run(
              "test:promotable",
              `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
               VALUES ('promoted_1', 'promoted@example.com', 'all', NULL, 'manual', '2026-07-03T12:00:00.000Z');`,
            ),
          ]),
        ),
      );

      await runtime.runPromise(
        upsertAutomatedSuppression({
          createdAt: "2026-07-04T00:00:00.000Z",
          email: "Promoted@Example.com",
          id: "ignored_automated_id",
          reason: "complaint",
          scope: "all",
        }),
      );

      expect(
        (
          await app.fetch(
            new Request("http://localhost/api/suppressions/manual_1", { method: "DELETE" }),
          )
        ).status,
      ).toBe(204);

      const conflict = await app.fetch(
        new Request("http://localhost/api/suppressions/promoted_1", { method: "DELETE" }),
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({
        error: {
          code: "conflict",
          message: "Only manual suppressions can be deleted through this API.",
        },
      });
      expect(
        (
          await app.fetch(
            new Request("http://localhost/api/suppressions/missing", { method: "DELETE" }),
          )
        ).status,
      ).toBe(404);
    });
  });

  it("manual suppressions affect mailing creation according to scope", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        unsubscribe: Option.some(fakeUnsubscribeConfig()),
      },
      async (app, runtime) => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const db = yield* Database;
            yield* db.run(
              "test:list",
              "INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Customers', '2026-07-03T12:00:00.000Z');",
            );
            yield* db.run(
              "test:list-2",
              "INSERT INTO lists (id, name, created_at) VALUES ('list_2', 'Customers 2', '2026-07-03T12:00:00.000Z');",
            );
            yield* db.run(
              "test:contact",
              "INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('contact_1', 'market@example.com', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');",
            );
            yield* db.run(
              "test:contact-2",
              "INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('contact_2', 'list@example.com', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');",
            );
            yield* db.run(
              "test:membership",
              "INSERT INTO list_memberships (list_id, contact_id, subscribed_at) VALUES ('list_1', 'contact_1', '2026-07-03T12:00:00.000Z');",
            );
            yield* db.run(
              "test:membership-2",
              "INSERT INTO list_memberships (list_id, contact_id, subscribed_at) VALUES ('list_2', 'contact_2', '2026-07-03T12:00:00.000Z');",
            );
          }),
        );

        expect(
          (
            await app.fetch(
              new Request("http://localhost/api/suppressions", {
                body: JSON.stringify({ email: "tx@example.com", scope: "all" }),
                headers: { "content-type": "application/json" },
                method: "POST",
              }),
            )
          ).status,
        ).toBe(201);
        expect(
          (
            await app.fetch(
              new Request("http://localhost/api/suppressions", {
                body: JSON.stringify({ email: "market@example.com", scope: "marketing" }),
                headers: { "content-type": "application/json" },
                method: "POST",
              }),
            )
          ).status,
        ).toBe(201);
        expect(
          (
            await app.fetch(
              new Request("http://localhost/api/suppressions", {
                body: JSON.stringify({
                  email: "list@example.com",
                  listId: "list_2",
                  scope: "list",
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
              }),
            )
          ).status,
        ).toBe(201);

        const transactionalBlocked = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({
              html: "<p>Hi</p>",
              purpose: "transactional",
              recipients: [{ email: "tx@example.com" }],
              subject: "Hi",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        );
        expect(transactionalBlocked.status).toBe(422);

        const transactionalAllowed = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({
              html: "<p>Hi</p>",
              purpose: "transactional",
              recipients: [{ email: "market@example.com" }],
              subject: "Hi",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        );
        expect(transactionalAllowed.status).toBe(201);

        const listSuppressedTransactionalAllowed = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({
              html: "<p>Hi</p>",
              purpose: "transactional",
              recipients: [{ email: "list@example.com" }],
              subject: "Hi",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        );
        expect(listSuppressedTransactionalAllowed.status).toBe(201);

        const marketingBlocked = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({
              html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
              listId: "list_1",
              purpose: "marketing",
              subject: "Hi",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        );
        expect(marketingBlocked.status).toBe(422);

        const listScopedMarketingBlocked = await app.fetch(
          new Request("http://localhost/api/mailings", {
            body: JSON.stringify({
              html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
              listId: "list_2",
              purpose: "marketing",
              subject: "Hi",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        );
        expect(listScopedMarketingBlocked.status).toBe(422);
      },
    );
  });
});
