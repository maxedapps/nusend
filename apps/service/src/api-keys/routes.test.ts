import { ListApiKeysResponseSchema } from "@nusend/api-contract";
import { Clock, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { withTestApp, type TestRuntime } from "../testing/layers.ts";

describe("api key routes", () => {
  it("creates, lists, uses, rotates, and revokes first-party API keys", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["key_1", "key_2"],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);

        const createdResponse = await app.fetch(
          jsonRequest("http://localhost/api/api-keys", {
            name: "local-cli",
            permissions: { api_keys: ["read", "write"], contacts: ["read"] },
          }),
        );
        expect(createdResponse.status).toBe(201);
        const created = (await createdResponse.json()) as {
          apiKey: {
            id: string;
            key: string;
            permissions: Record<string, string[]>;
            preview: string;
          };
        };
        expect(created.apiKey.id).toBe("key_1");
        expect(created.apiKey.key).toMatch(/^nusend_/);
        expect(created.apiKey.preview).not.toBe(created.apiKey.key);

        const listResponse = await app.fetch(new Request("http://localhost/api/api-keys"));
        expect(listResponse.status).toBe(200);
        const listedText = await listResponse.text();
        expect(listedText).toContain("local-cli");
        expect(listedText).not.toContain(created.apiKey.key);

        const meResponse = await app.fetch(
          new Request("http://localhost/api/me", { headers: { "x-api-key": created.apiKey.key } }),
        );
        expect(meResponse.status).toBe(200);
        await expect(meResponse.json()).resolves.toEqual({
          principal: {
            apiKeyId: "key_1",
            kind: "api_key",
            permissions: { api_keys: ["read", "write"], contacts: ["read"] },
            userId: "user_1",
          },
        });

        const storedAfterUse = await readApiKeyRows(runtime);
        expect(storedAfterUse[0]?.key_hash).not.toContain(created.apiKey.key);
        expect(storedAfterUse[0]?.key_preview).not.toBe(created.apiKey.key);
        expect(storedAfterUse[0]?.last_used_at).not.toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 10));
        const secondMeResponse = await app.fetch(
          new Request("http://localhost/api/me", { headers: { "x-api-key": created.apiKey.key } }),
        );
        expect(secondMeResponse.status).toBe(200);
        expect((await readApiKeyRows(runtime))[0]?.last_used_at).toBe(
          storedAfterUse[0]?.last_used_at,
        );

        await ageLastUsed(runtime, "key_1");
        const agedMeResponse = await app.fetch(
          new Request("http://localhost/api/me", { headers: { "x-api-key": created.apiKey.key } }),
        );
        expect(agedMeResponse.status).toBe(200);
        expect((await readApiKeyRows(runtime))[0]?.last_used_at).not.toBe(
          "2000-01-01T00:00:00.000Z",
        );

        const rotatedResponse = await app.fetch(
          new Request("http://localhost/api/api-keys/key_1/rotate", {
            headers: { "x-api-key": created.apiKey.key },
            method: "POST",
          }),
        );
        expect(rotatedResponse.status).toBe(200);
        const rotated = (await rotatedResponse.json()) as {
          apiKey: { expiresAt: string | null; key: string; name: string };
        };
        expect(rotated.apiKey.key).toMatch(/^nusend_/);
        expect(rotated.apiKey.expiresAt).toBeNull();
        expect(rotated.apiKey.name).toBe("local-cli");
        expect(rotated.apiKey.key).not.toBe(created.apiKey.key);

        const oldKeyResponse = await app.fetch(
          new Request("http://localhost/api/me", { headers: { "x-api-key": created.apiKey.key } }),
        );
        expect(oldKeyResponse.status).toBe(401);

        const revokeResponse = await app.fetch(
          new Request("http://localhost/api/api-keys/key_2", {
            headers: { "x-api-key": rotated.apiKey.key },
            method: "DELETE",
          }),
        );
        expect(revokeResponse.status).toBe(204);

        const revokedResponse = await app.fetch(
          new Request("http://localhost/api/me", { headers: { "x-api-key": rotated.apiKey.key } }),
        );
        expect(revokedResponse.status).toBe(401);
      },
    );
  });

  it("forbids a scoped key from revoking a broader key but lets the owner revoke it", async () => {
    await withTestApp(
      { auth: { session: { userId: "user_1" } }, ids: ["broad", "narrow"], realApiKeys: true },
      async (app, runtime) => {
        await seedUser(runtime);

        const broad = (await (
          await app.fetch(
            jsonRequest("http://localhost/api/api-keys", {
              name: "broad",
              permissions: { api_keys: ["read", "write"], contacts: ["read", "write"] },
            }),
          )
        ).json()) as { apiKey: { id: string; key: string } };

        // Narrow key can manage keys (api_keys:write) but lacks contacts:write.
        const narrow = (await (
          await app.fetch(
            jsonRequest("http://localhost/api/api-keys", {
              name: "narrow",
              permissions: { api_keys: ["read", "write"], contacts: ["read"] },
            }),
          )
        ).json()) as { apiKey: { id: string; key: string } };

        // Narrow key revoking the broader key → 403 (would otherwise be a lockout vector).
        const forbidden = await app.fetch(
          new Request(`http://localhost/api/api-keys/${broad.apiKey.id}`, {
            headers: { "x-api-key": narrow.apiKey.key },
            method: "DELETE",
          }),
        );
        expect(forbidden.status).toBe(403);

        // The session owner can still revoke the broad key.
        const ownerRevoke = await app.fetch(
          new Request(`http://localhost/api/api-keys/${broad.apiKey.id}`, { method: "DELETE" }),
        );
        expect(ownerRevoke.status).toBe(204);
      },
    );
  });

  it("rejects unknown permission resources", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["key_1"],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);

        const response = await app.fetch(
          jsonRequest("http://localhost/api/api-keys", {
            name: "invalid",
            permissions: { bogus: ["read"] },
          }),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "invalid_request" },
        });
      },
    );
  });

  it("validates API-key expiry values", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["key_1"],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);

        const malformed = await app.fetch(
          jsonRequest("http://localhost/api/api-keys", {
            expiresAt: "not-a-date",
            name: "bad",
            permissions: { contacts: ["read"] },
          }),
        );
        expect(malformed.status).toBe(400);

        const expired = await app.fetch(
          jsonRequest("http://localhost/api/api-keys", {
            expiresAt: "2000-01-01T00:00:00.000Z",
            name: "expired",
            permissions: { contacts: ["read"] },
          }),
        );
        expect(expired.status).toBe(400);
      },
    );
  });

  it("preserves future expiry and refreshes expired keys during rotation", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: [
          "future_key",
          "future_rotated",
          "expired_key",
          "expired_rotated",
          "malformed_key",
          "malformed_rotated",
        ],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        const futureExpiry = "2099-01-01T00:00:00.000Z";
        const future = await createKey(app, {
          expiresAt: futureExpiry,
          name: "future",
          permissions: { contacts: ["read"] },
        });
        const futureRotated = await app.fetch(
          new Request(`http://localhost/api/api-keys/${future.id}/rotate`, { method: "POST" }),
        );
        expect(futureRotated.status).toBe(200);
        await expect(futureRotated.json()).resolves.toMatchObject({
          apiKey: { expiresAt: futureExpiry, name: "future" },
        });

        const expired = await createKey(app, {
          name: "expired",
          permissions: { contacts: ["read"] },
        });
        await expireApiKey(runtime, expired.id);
        const expiredRotated = await app.fetch(
          new Request(`http://localhost/api/api-keys/${expired.id}/rotate`, { method: "POST" }),
        );
        expect(expiredRotated.status).toBe(200);
        const body = (await expiredRotated.json()) as {
          apiKey: { expiresAt: string; name: string };
        };
        expect(body.apiKey.name).toBe("expired");
        // rotationExpiry uses TestClock + 365 days (TestClock is not advanced here).
        const clockNow = await runtime.runPromise(Clock.currentTimeMillis);
        expect(Date.parse(body.apiKey.expiresAt)).toBe(clockNow + 365 * 24 * 60 * 60 * 1000);

        const malformed = await createKey(app, {
          name: "malformed",
          permissions: { contacts: ["read"] },
        });
        await setApiKeyExpiry(runtime, malformed.id, "not-a-date");
        const malformedRotated = await app.fetch(
          new Request(`http://localhost/api/api-keys/${malformed.id}/rotate`, { method: "POST" }),
        );
        expect(malformedRotated.status).toBe(200);
        const malformedBody = (await malformedRotated.json()) as {
          apiKey: { expiresAt: string };
        };
        expect(Date.parse(malformedBody.apiKey.expiresAt)).toBe(
          clockNow + 365 * 24 * 60 * 60 * 1000,
        );
      },
    );
  });

  it("paginates API-key lists and rejects invalid limits", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["key_1", "key_2", "key_3"],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        await createKey(app, { name: "one", permissions: { contacts: ["read"] } });
        await createKey(app, { name: "two", permissions: { contacts: ["read"] } });
        await createKey(app, { name: "three", permissions: { contacts: ["read"] } });

        const first = await app.fetch(
          new Request("http://localhost/api/api-keys?limit=2&offset=0"),
        );
        expect(first.status).toBe(200);
        const firstBody = await first.json();
        expect(() => Schema.decodeUnknownSync(ListApiKeysResponseSchema)(firstBody)).not.toThrow();
        expect(firstBody).toMatchObject({
          items: [{ id: "key_3" }, { id: "key_2" }],
          pagination: { limit: 2, nextOffset: 2, offset: 0 },
        });

        const exactFinal = await app.fetch(
          new Request("http://localhost/api/api-keys?limit=3&offset=0"),
        );
        await expect(exactFinal.json()).resolves.toMatchObject({
          items: [{ id: "key_3" }, { id: "key_2" }, { id: "key_1" }],
          pagination: { limit: 3, nextOffset: null, offset: 0 },
        });

        const final = await app.fetch(
          new Request("http://localhost/api/api-keys?limit=2&offset=2"),
        );
        await expect(final.json()).resolves.toMatchObject({
          items: [{ id: "key_1" }],
          pagination: { limit: 2, nextOffset: null, offset: 2 },
        });

        const invalid = await app.fetch(new Request("http://localhost/api/api-keys?limit=0"));
        expect(invalid.status).toBe(400);
      },
    );
  });

  it("rejects past and malformed stored expiry during authentication", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["past_key", "malformed_key"],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        const past = await createKey(app, {
          name: "past",
          permissions: { contacts: ["read"] },
        });
        const malformed = await createKey(app, {
          name: "malformed",
          permissions: { contacts: ["read"] },
        });
        await setApiKeyExpiry(runtime, past.id, "2000-01-01T00:00:00.000Z");
        await setApiKeyExpiry(runtime, malformed.id, "not-a-date");

        const responses = await Promise.all(
          [past.key, malformed.key].map((key) =>
            app.fetch(new Request("http://localhost/api/me", { headers: { "x-api-key": key } })),
          ),
        );
        expect(responses.map((response) => response.status)).toEqual([401, 401]);
      },
    );
  });

  it("returns internal_error for corrupt stored permissions", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["good_key", "bad_key"],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        const good = await createKey(app, {
          name: "good",
          permissions: { contacts: ["read"] },
        });
        const bad = await createKey(app, {
          name: "bad",
          permissions: { contacts: ["read"] },
        });
        await corruptPermissions(runtime, bad.id);

        const list = await app.fetch(new Request("http://localhost/api/api-keys"));
        expect(list.status).toBe(500);
        await expect(list.json()).resolves.toMatchObject({ error: { code: "internal_error" } });

        const corruptedAuth = await app.fetch(
          new Request("http://localhost/api/me", { headers: { "x-api-key": bad.key } }),
        );
        expect(corruptedAuth.status).toBe(500);
        await expect(corruptedAuth.json()).resolves.toMatchObject({
          error: { code: "internal_error" },
        });

        const validAuth = await app.fetch(
          new Request("http://localhost/api/me", { headers: { "x-api-key": good.key } }),
        );
        expect(validAuth.status).toBe(200);

        const rotate = await app.fetch(
          new Request(`http://localhost/api/api-keys/${bad.id}/rotate`, { method: "POST" }),
        );
        expect(rotate.status).toBe(500);
        await expect(rotate.json()).resolves.toMatchObject({ error: { code: "internal_error" } });
      },
    );
  });

  it("requires API-key read/write permissions for key-management endpoints", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["key_1"],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);

        const createdResponse = await app.fetch(
          jsonRequest("http://localhost/api/api-keys", {
            name: "contacts-only",
            permissions: { contacts: ["read"] },
          }),
        );
        const created = (await createdResponse.json()) as { apiKey: { key: string } };

        const listResponse = await app.fetch(
          new Request("http://localhost/api/api-keys", {
            headers: { "x-api-key": created.apiKey.key },
          }),
        );
        expect(listResponse.status).toBe(403);

        const createResponse = await app.fetch(
          jsonRequest(
            "http://localhost/api/api-keys",
            { name: "denied", permissions: { contacts: ["read"] } },
            created.apiKey.key,
          ),
        );
        expect(createResponse.status).toBe(403);
      },
    );
  });

  it("enforces API-key permission subsets when creating keys", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["owner_key", "subset_key"],
        realApiKeys: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);

        const ownerResponse = await app.fetch(
          jsonRequest("http://localhost/api/api-keys", {
            name: "scoped",
            permissions: { api_keys: ["write"], contacts: ["read"] },
          }),
        );
        const owner = (await ownerResponse.json()) as { apiKey: { key: string } };

        const subsetResponse = await app.fetch(
          jsonRequest(
            "http://localhost/api/api-keys",
            { name: "subset", permissions: { contacts: ["read"] } },
            owner.apiKey.key,
          ),
        );
        expect(subsetResponse.status).toBe(201);

        const forbiddenResponse = await app.fetch(
          jsonRequest(
            "http://localhost/api/api-keys",
            { name: "too broad", permissions: { contacts: ["write"] } },
            owner.apiKey.key,
          ),
        );
        expect(forbiddenResponse.status).toBe(403);
        await expect(forbiddenResponse.json()).resolves.toEqual({
          error: {
            code: "forbidden",
            message: "Requested permissions exceed the current API key.",
          },
        });
      },
    );
  });
});

function jsonRequest(url: string, body: unknown, apiKey?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (apiKey) headers.set("x-api-key", apiKey);
  return new Request(url, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}

async function createKey(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  body: {
    readonly expiresAt?: string;
    readonly name: string;
    readonly permissions: Record<string, string[]>;
  },
): Promise<{ id: string; key: string }> {
  const response = await app.fetch(jsonRequest("http://localhost/api/api-keys", body));
  expect(response.status).toBe(201);
  const result = (await response.json()) as { apiKey: { id: string; key: string } };
  return result.apiKey;
}

async function corruptPermissions(runtime: TestRuntime, id: string): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "apiKeysTest:corruptPermissions",
        "UPDATE api_keys SET permissions_json = 'not-json' WHERE id = $id;",
        { id },
      );
    }),
  );
}

async function ageLastUsed(runtime: TestRuntime, id: string): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "apiKeysTest:ageLastUsed",
        "UPDATE api_keys SET last_used_at = '2000-01-01T00:00:00.000Z' WHERE id = $id;",
        { id },
      );
    }),
  );
}

async function expireApiKey(runtime: TestRuntime, id: string): Promise<void> {
  await setApiKeyExpiry(runtime, id, "2000-01-01T00:00:00.000Z");
}

async function setApiKeyExpiry(runtime: TestRuntime, id: string, expiresAt: string): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "apiKeysTest:setExpiry",
        "UPDATE api_keys SET expires_at = $expiresAt WHERE id = $id;",
        { expiresAt, id },
      );
    }),
  );
}

async function readApiKeyRows(
  runtime: TestRuntime,
): Promise<readonly { key_hash: string; key_preview: string; last_used_at: string | null }[]> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      return yield* db.all<{ key_hash: string; key_preview: string; last_used_at: string | null }>(
        "apiKeysTest:readRows",
        "SELECT key_hash, key_preview, last_used_at FROM api_keys ORDER BY created_at, id;",
      );
    }),
  );
}

async function seedUser(runtime: TestRuntime): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "apiKeysTest:seedUser",
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES ('user_1', 'Max', 'max@example.com', 1, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');`,
      );
    }),
  );
}
