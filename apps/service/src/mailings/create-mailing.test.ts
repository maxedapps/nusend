import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupBunScenarios, runBunScenario } from "../testing/bun-scenario.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => cleanupBunScenarios());

describe("createMailing", () => {
  it("persists explicit recipients, schedules jobs, and handles suppressions", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        const ids = createIdFactory();
        const result = createMailing(db, {
          html: "<p>Hello</p>",
          listId: null,
          name: null,
          purpose: "transactional",
          recipients: [{ email: "user@example.com", varsJson: '{"firstName":"Max"}' }],
          scheduledAt: null,
          subject: "Hello",
          text: "Hello",
        }, { createId: ids, now: () => "2026-07-03T12:00:00.000Z" });

        assertEqual(result.counts, { deliveries: 1, queued: 1, suppressed: 0 });
        assertEqual(result.mailing.scheduledAt, "2026-07-03T12:00:00.000Z");
        assertEqual(selectSingle(db, "SELECT purpose, state, scheduled_at AS scheduledAt FROM mailings;"), {
          purpose: "transactional",
          scheduledAt: "2026-07-03T12:00:00.000Z",
          state: "scheduled",
        });
        assertEqual(selectSingle(db, "SELECT email, status, vars_json AS varsJson FROM deliveries;"), {
          email: "user@example.com",
          status: "queued",
          varsJson: '{"firstName":"Max"}',
        });
        assertEqual(selectSingle(db, "SELECT kind, state, run_at AS runAt FROM jobs;"), {
          kind: "send_delivery",
          runAt: "2026-07-03T12:00:00.000Z",
          state: "queued",
        });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("uses provided scheduledAt for the mailing and queued jobs", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        createMailing(db, {
          html: "<p>Hello</p>",
          listId: null,
          name: null,
          purpose: "transactional",
          recipients: [{ email: "user@example.com", varsJson: null }],
          scheduledAt: "2026-08-01T10:00:00.000Z",
          subject: "Hello",
          text: null,
        }, { createId: createIdFactory(), now: () => "2026-07-03T12:00:00.000Z" });
        assertEqual(selectSingle(db, "SELECT scheduled_at AS scheduledAt FROM mailings;").scheduledAt, "2026-08-01T10:00:00.000Z");
        assertEqual(selectSingle(db, "SELECT run_at AS runAt FROM jobs;").runAt, "2026-08-01T10:00:00.000Z");
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("links explicit recipients to existing contacts without creating contacts", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        db.query("INSERT INTO contacts (id, email, attrs_json, created_at, updated_at) VALUES ('contact_1', 'USER@example.com', NULL, $now, $now);").run({ now: "2026-07-03T12:00:00.000Z" });
        createMailing(db, {
          html: "<p>Hello</p>",
          listId: null,
          name: null,
          purpose: "transactional",
          recipients: [{ email: "user@example.com", varsJson: null }],
          scheduledAt: null,
          subject: "Hello",
          text: null,
        }, { createId: createIdFactory(), now: () => "2026-07-03T12:00:00.000Z" });
        assertEqual(selectSingle(db, "SELECT contact_id AS contactId FROM deliveries;").contactId, "contact_1");
        assertEqual(selectSingle(db, "SELECT count(*) AS count FROM contacts;").count, 1);
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("snapshots subscribed list contacts only", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedList(db);
        createMailing(db, {
          html: "<p>Hello</p>",
          listId: "list_1",
          name: "Newsletter",
          purpose: "marketing",
          recipients: null,
          scheduledAt: null,
          subject: "Hello",
          text: null,
        }, { createId: createIdFactory(), now: () => "2026-07-03T12:00:00.000Z" });
        assertEqual(selectAll(db, "SELECT email, contact_id AS contactId, vars_json AS varsJson, status FROM deliveries ORDER BY email;"), [
          { contactId: "contact_1", email: "subscribed@example.com", status: "queued", varsJson: null },
        ]);
        assertEqual(selectSingle(db, "SELECT count(*) AS count FROM jobs;").count, 1);
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("applies global, marketing, and list suppression rules", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        const now = "2026-07-03T12:00:00.000Z";
        db.query("INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Newsletter', $now);").run({ now });
        db.query("INSERT INTO lists (id, name, created_at) VALUES ('list_2', 'Other', $now);").run({ now });
        for (const [id, email] of [
          ["contact_ok", "ok@example.com"],
          ["contact_global", "global@example.com"],
          ["contact_marketing", "marketing@example.com"],
          ["contact_list", "list@example.com"],
          ["contact_other_list", "other-list@example.com"],
        ]) {
          db.query("INSERT INTO contacts (id, email, attrs_json, created_at, updated_at) VALUES ($id, $email, NULL, $now, $now);").run({ email, id, now });
          db.query("INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at) VALUES ('list_1', $id, $now, NULL);").run({ id, now });
        }
        db.query("INSERT INTO suppressions (id, email, scope, list_id, reason, created_at) VALUES ($id, $email, $scope, $listId, 'manual', $now);").run({ email: "global@example.com", id: "sup_1", listId: null, now: "2026-07-03T12:00:00.000Z", scope: "all" });
        db.query("INSERT INTO suppressions (id, email, scope, list_id, reason, created_at) VALUES ($id, $email, $scope, $listId, 'manual', $now);").run({ email: "marketing@example.com", id: "sup_2", listId: null, now: "2026-07-03T12:00:00.000Z", scope: "marketing" });
        db.query("INSERT INTO suppressions (id, email, scope, list_id, reason, created_at) VALUES ($id, $email, $scope, $listId, 'manual', $now);").run({ email: "list@example.com", id: "sup_3", listId: "list_1", now: "2026-07-03T12:00:00.000Z", scope: "list" });
        db.query("INSERT INTO suppressions (id, email, scope, list_id, reason, created_at) VALUES ($id, $email, $scope, $listId, 'manual', $now);").run({ email: "other-list@example.com", id: "sup_4", listId: "list_2", now: "2026-07-03T12:00:00.000Z", scope: "list" });

        const marketing = createMailing(db, {
          html: "<p>Hello</p>",
          listId: "list_1",
          name: null,
          purpose: "marketing",
          recipients: null,
          scheduledAt: null,
          subject: "Hello",
          text: null,
        }, { createId: createIdFactory(), now: () => "2026-07-03T12:00:00.000Z" });
        assertEqual(marketing.counts, { deliveries: 5, queued: 2, suppressed: 3 });
        assertEqual(selectSingle(db, "SELECT count(*) AS count FROM jobs;").count, 2);

        const transactional = createMailing(db, {
          html: "<p>Hello</p>",
          listId: null,
          name: null,
          purpose: "transactional",
          recipients: [
            { email: "ok2@example.com", varsJson: null },
            { email: "marketing@example.com", varsJson: null },
            { email: "list@example.com", varsJson: null },
            { email: "global@example.com", varsJson: null },
          ],
          scheduledAt: null,
          subject: "Hello",
          text: null,
        }, { createId: createIdFactory(100), now: () => "2026-07-03T12:00:00.000Z" });
        assertEqual(transactional.counts, { deliveries: 4, queued: 3, suppressed: 1 });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("rejects empty, all-suppressed, and missing-list requests without writes", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedList(db, { subscribed: false });
        assertThrowsCode(() => createMailing(db, {
          html: "<p>Hello</p>", listId: "list_1", name: null, purpose: "marketing", recipients: null,
          scheduledAt: null, subject: "Hello", text: null,
        }, { createId: createIdFactory(), now: () => "2026-07-03T12:00:00.000Z" }), "empty_recipient_set");
        assertEqual(countRows(db), { deliveries: 0, jobs: 0, mailings: 0 });

        db.query("INSERT INTO suppressions (id, email, scope, list_id, reason, created_at) VALUES ('sup_1', 'only@example.com', 'all', NULL, 'manual', $now);").run({ now: "2026-07-03T12:00:00.000Z" });
        assertThrowsCode(() => createMailing(db, {
          html: "<p>Hello</p>", listId: null, name: null, purpose: "transactional",
          recipients: [{ email: "only@example.com", varsJson: null }], scheduledAt: null, subject: "Hello", text: null,
        }, { createId: createIdFactory(), now: () => "2026-07-03T12:00:00.000Z" }), "empty_recipient_set");
        assertEqual(countRows(db), { deliveries: 0, jobs: 0, mailings: 0 });

        assertThrowsCode(() => createMailing(db, {
          html: "<p>Hello</p>", listId: "missing", name: null, purpose: "marketing", recipients: null,
          scheduledAt: null, subject: "Hello", text: null,
        }, { createId: createIdFactory(), now: () => "2026-07-03T12:00:00.000Z" }), "list_not_found");
        assertEqual(countRows(db), { deliveries: 0, jobs: 0, mailings: 0 });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("rolls back all writes when an insert fails mid-transaction", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        const ids = ["mailing_1", "delivery_1", "job_1", "delivery_1"];
        assertThrows(() => createMailing(db, {
          html: "<p>Hello</p>", listId: null, name: null, purpose: "transactional",
          recipients: [
            { email: "one@example.com", varsJson: null },
            { email: "two@example.com", varsJson: null },
          ],
          scheduledAt: null, subject: "Hello", text: null,
        }, { createId: () => ids.shift() ?? "fallback", now: () => "2026-07-03T12:00:00.000Z" }));
        assertEqual(countRows(db), { deliveries: 0, jobs: 0, mailings: 0 });
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
    import { createMailing } from ${JSON.stringify(`${serviceRoot}src/mailings/create-mailing.ts`)};

    function createMigratedDatabase() {
      const db = new Database(":memory:", { strict: true });
      db.run("PRAGMA foreign_keys = ON;");
      for (const file of ["0001_initial_schema.sql"]) {
        const migration = parseMigrationFile(file.replace(/\\.sql$/, ""), readFileSync(${JSON.stringify(`${serviceRoot}src/db/migrations/sql/`)} + file, "utf8"));
        db.run(migration.upSql);
      }
      return db;
    }

    function createIdFactory(offset = 0) {
      let index = offset;
      return () => "id_" + index++;
    }

    function seedList(db, options = { subscribed: true }) {
      const now = "2026-07-03T12:00:00.000Z";
      db.query("INSERT INTO lists (id, name, created_at) VALUES ('list_1', 'Newsletter', $now);").run({ now });
      db.query("INSERT INTO contacts (id, email, attrs_json, created_at, updated_at) VALUES ('contact_1', 'subscribed@example.com', '{\\"firstName\\":\\"Sub\\"}', $now, $now);").run({ now });
      db.query("INSERT INTO contacts (id, email, attrs_json, created_at, updated_at) VALUES ('contact_2', 'unsubscribed@example.com', NULL, $now, $now);").run({ now });
      db.query("INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at) VALUES ('list_1', 'contact_1', $now, $unsubscribedAt);").run({ now, unsubscribedAt: options.subscribed ? null : now });
      db.query("INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at) VALUES ('list_1', 'contact_2', $now, $now);").run({ now });
    }

    function countRows(db) {
      return {
        deliveries: selectSingle(db, "SELECT count(*) AS count FROM deliveries;").count,
        jobs: selectSingle(db, "SELECT count(*) AS count FROM jobs;").count,
        mailings: selectSingle(db, "SELECT count(*) AS count FROM mailings;").count,
      };
    }

    function selectSingle(db, sql) {
      return db.query(sql).get();
    }

    function selectAll(db, sql) {
      return db.query(sql).all();
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

    function assertThrows(callback) {
      try {
        callback();
      } catch {
        return;
      }
      throw new Error("Expected callback to throw.");
    }

    function assertThrowsCode(callback, code) {
      try {
        callback();
      } catch (error) {
        if (error?.code === code) return;
        throw new Error("Expected error code " + code + ", got " + error?.code);
      }
      throw new Error("Expected callback to throw " + code + ".");
    }

    ${body}
    console.log("OK");
  `;
}
