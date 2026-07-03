import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupBunScenarios, runBunScenario } from "../testing/bun-scenario.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => cleanupBunScenarios());

describe("mailings routes", () => {
  it("enforces auth and API-key permissions", () => {
    const result = runBunScenario(
      scenarioScript(`
        const noAuth = await postMailing({ auth: createAuth({ session: null }) });
        assertEqual(noAuth.status, 401);
        assertEqual(await noAuth.json(), { error: { code: "unauthenticated", message: "Authentication required." } });

        const invalidKey = await postMailing({
          auth: createAuth({ apiKeyValid: false }),
          headers: { "x-api-key": "invalid" },
        });
        assertEqual(invalidKey.status, 401);
        assertEqual(await invalidKey.json(), { error: { code: "unauthenticated", message: "Invalid API key." } });

        const missingPermission = await postMailing({
          auth: createAuth({ apiKeyPermissions: { mailings: ["read"] } }),
          headers: { "x-api-key": "valid" },
        });
        assertEqual(missingPermission.status, 403);
        assertEqual(await missingPermission.json(), {
          error: { code: "forbidden", message: "API key does not have the required permissions." },
        });
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("creates a mailing with a valid API key", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        const auth = createAuth({ apiKeyPermissions: { mailings: ["create"] } });
        const app = createApp({ auth, db });
        const response = await app.fetch(new Request("http://localhost/api/mailings", {
          body: JSON.stringify(validBody),
          headers: { "content-type": "application/json", "x-api-key": "valid" },
          method: "POST",
        }));
        assertEqual(response.status, 201);
        const json = await response.json();
        assertEqual(json.mailing.purpose, "transactional");
        assertEqual(json.mailing.state, "scheduled");
        assertEqual(json.counts, { deliveries: 1, queued: 1, suppressed: 0 });
        assertEqual(typeof json.mailing.id, "string");
        assertEqual(typeof json.mailing.scheduledAt, "string");
        assertEqual(countRows(db), { deliveries: 1, jobs: 1, mailings: 1 });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("creates a mailing with a valid session principal", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedMember(db);
        const auth = createAuth({ session: { activeOrganizationId: null, userId: "user_1" } });
        const app = createApp({ auth, db });
        const response = await app.fetch(new Request("http://localhost/api/mailings", {
          body: JSON.stringify(validBody),
          headers: { "content-type": "application/json" },
          method: "POST",
        }));
        assertEqual(response.status, 201);
        const json = await response.json();
        assertEqual(json.counts, { deliveries: 1, queued: 1, suppressed: 0 });
        assertEqual(countRows(db), { deliveries: 1, jobs: 1, mailings: 1 });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("maps malformed JSON, invalid payloads, missing lists, and empty recipient sets", () => {
    const result = runBunScenario(
      scenarioScript(`
        const malformed = await postMailing({ body: "{", auth: createAuth({ apiKeyPermissions: { mailings: ["create"] } }), headers: { "x-api-key": "valid" } });
        assertEqual(malformed.status, 400);
        assertEqual(await malformed.json(), { error: { code: "invalid_request", message: "Request body must be valid JSON." } });

        const invalid = await postMailing({ body: JSON.stringify({ ...validBody, subject: "" }), auth: createAuth({ apiKeyPermissions: { mailings: ["create"] } }), headers: { "x-api-key": "valid" } });
        assertEqual(invalid.status, 400);
        assertEqual(await invalid.json(), { error: { code: "invalid_request", message: "subject must not be empty." } });

        const missingList = await postMailing({ body: JSON.stringify({ html: "<p>Hello</p>", listId: "missing", purpose: "marketing", subject: "Hello" }), auth: createAuth({ apiKeyPermissions: { mailings: ["create"] } }), headers: { "x-api-key": "valid" } });
        assertEqual(missingList.status, 404);
        assertEqual(await missingList.json(), { error: { code: "not_found", message: "List not found." } });

        const db = createMigratedDatabase();
        db.query("INSERT INTO suppressions (id, email, scope, list_id, reason, created_at) VALUES ('sup_1', 'user@example.com', 'all', NULL, 'manual', $now);").run({ now: "2026-07-03T12:00:00.000Z" });
        const app = createApp({ auth: createAuth({ apiKeyPermissions: { mailings: ["create"] } }), db });
        const suppressed = await app.fetch(new Request("http://localhost/api/mailings", {
          body: JSON.stringify(validBody),
          headers: { "content-type": "application/json", "x-api-key": "valid" },
          method: "POST",
        }));
        assertEqual(suppressed.status, 422);
        assertEqual(await suppressed.json(), {
          error: {
            code: "empty_recipient_set",
            message: "Mailing has no sendable recipients after suppression checks.",
          },
        });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });
});

function scenarioScript(body: string): string {
  return `
    import { Database } from "bun:sqlite";
    import { readFileSync } from "node:fs";
    import { parseMigrationFile } from ${JSON.stringify(`${serviceRoot}src/db/migration-files.ts`)};
    import { createApp } from ${JSON.stringify(`${serviceRoot}src/app.ts`)};

    const validBody = {
      html: "<p>Hello</p>",
      purpose: "transactional",
      recipients: [{ email: "user@example.com" }],
      subject: "Hello",
    };

    function createMigratedDatabase() {
      const db = new Database(":memory:", { strict: true });
      db.run("PRAGMA foreign_keys = ON;");
      for (const file of ["0001_initial_schema.sql", "0002_auth.sql"]) {
        const migration = parseMigrationFile(file.replace(/\\.sql$/, ""), readFileSync(${JSON.stringify(`${serviceRoot}src/db/migrations/sql/`)} + file, "utf8"));
        db.run(migration.upSql);
      }
      return db;
    }

    function createAuth(options) {
      return {
        api: {
          getSession: async () => options.session ? { session: options.session, user: { id: options.session.userId } } : null,
          verifyApiKey: async () => options.apiKeyValid === false
            ? { error: { code: "INVALID_API_KEY", message: "Invalid API key." }, key: null, valid: false }
            : {
                error: null,
                key: {
                  id: "key_1",
                  permissions: options.apiKeyPermissions ?? {},
                  referenceId: "org_1",
                },
                valid: true,
              },
        },
        handler: async () => Response.json({ handled: true }),
      };
    }

    async function postMailing(options) {
      const db = createMigratedDatabase();
      const app = createApp({ auth: options.auth, db });
      const response = await app.fetch(new Request("http://localhost/api/mailings", {
        body: options.body ?? JSON.stringify(validBody),
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
        method: "POST",
      }));
      db.close();
      return response;
    }

    function seedMember(db) {
      const now = "2026-07-03T12:00:00.000Z";
      db.query("INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at) VALUES ('user_1', 'User', 'user@example.com', 1, NULL, $now, $now);").run({ now });
      db.query("INSERT INTO organizations (id, name, slug, logo, created_at, metadata) VALUES ('org_1', 'Nusend', 'nusend', NULL, $now, NULL);").run({ now });
      db.query("INSERT INTO organization_members (id, organization_id, user_id, role, created_at) VALUES ('member_1', 'org_1', 'user_1', 'member', $now);").run({ now });
    }

    function countRows(db) {
      return {
        deliveries: db.query("SELECT count(*) AS count FROM deliveries;").get().count,
        jobs: db.query("SELECT count(*) AS count FROM jobs;").get().count,
        mailings: db.query("SELECT count(*) AS count FROM mailings;").get().count,
      };
    }

    function assertEqual(actual, expected) {
      const actualJson = stableJson(actual);
      const expectedJson = stableJson(expected);
      if (actualJson !== expectedJson) {
        throw new Error("Assertion failed:\\nactual: " + actualJson + "\\nexpected: " + expectedJson);
      }
    }

    function stableJson(value) {
      if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
      if (value && typeof value === "object") {
        return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
      }
      return JSON.stringify(value);
    }

    ${body}
    console.log("OK");
  `;
}
