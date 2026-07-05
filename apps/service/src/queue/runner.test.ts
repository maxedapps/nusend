import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupBunScenarios, runBunScenario } from "../testing/bun-scenario.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => cleanupBunScenarios());

describe("queue runner", () => {
  it("completes jobs after a successful processor", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedJob(db, { id: "job_1" });
        const seen = [];
        const result = await runOnce({
          db,
          now: fixedNow(["2026-07-03T12:00:00.000Z", "2026-07-03T12:00:01.000Z"]),
          processJob: async (job) => {
            seen.push({ attempts: job.attempts, id: job.id, state: job.state });
          },
          workerId: "worker_1",
        });

        assertEqual(seen, [{ attempts: 1, id: "job_1", state: "leased" }]);
        assertEqual(result, { claimed: 1, dead: 0, failed: 0, released: 0, skippedStale: 0, succeeded: 1 });
        assertEqual(selectSingle(db, "SELECT state, locked_by AS lockedBy FROM jobs WHERE id = 'job_1';"), {
          lockedBy: null,
          state: "succeeded",
        });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("requeues or dead-letters jobs when processors throw", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedJob(db, { id: "retry" });
        seedJob(db, { id: "dead", maxAttempts: 1 });
        const result = await runOnce({
          batchSize: 2,
          db,
          now: () => "2026-07-03T12:00:00.000Z",
          processJob: async () => {
            throw new Error("send failed");
          },
          workerId: "worker_1",
        });

        assertEqual(result, { claimed: 2, dead: 1, failed: 1, released: 0, skippedStale: 0, succeeded: 0 });
        assertEqual(selectAll(db, "SELECT id, state, run_at AS runAt, last_error AS lastError FROM jobs ORDER BY id;"), [
          { id: "dead", lastError: "send failed", runAt: "2026-07-03T11:00:00.000Z", state: "dead" },
          { id: "retry", lastError: "send failed", runAt: "2026-07-03T12:01:00.000Z", state: "queued" },
        ]);
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("releases expired leases before claiming jobs", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedJob(db, {
          attempts: 1,
          id: "expired",
          lockedBy: "old_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          state: "leased",
        });
        seedJob(db, {
          attempts: 1,
          id: "expired_dead",
          lockedBy: "old_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          maxAttempts: 1,
          state: "leased",
        });
        const result = await runOnce({
          db,
          now: fixedNow(["2026-07-03T12:00:00.000Z"]),
          processJob: async () => {},
          workerId: "worker_1",
        });

        assertEqual(result, { claimed: 0, dead: 1, failed: 0, released: 2, skippedStale: 0, succeeded: 0 });
        assertEqual(selectSingle(db, "SELECT state, run_at AS runAt, locked_by AS lockedBy FROM jobs WHERE id = 'expired';"), {
          lockedBy: null,
          runAt: "2026-07-03T12:01:00.000Z",
          state: "queued",
        });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("does not crash when completion or failure observes a stale lease", () => {
    const result = runBunScenario(
      scenarioScript(`
        const successDb = createMigratedDatabase();
        seedJob(successDb, { id: "success_stale" });
        const success = await runOnce({
          db: successDb,
          now: fixedNow(["2026-07-03T12:00:00.000Z", "2026-07-03T12:00:01.000Z"]),
          processJob: async (job) => {
            successDb.query("UPDATE jobs SET locked_by = 'other' WHERE id = $id;").run({ id: job.id });
          },
          workerId: "worker_1",
        });
        assertEqual(success.skippedStale, 1);
        successDb.close();

        const failureDb = createMigratedDatabase();
        seedJob(failureDb, { id: "failure_stale" });
        const failure = await runOnce({
          db: failureDb,
          now: fixedNow(["2026-07-03T12:00:00.000Z", "2026-07-03T12:00:01.000Z"]),
          processJob: async (job) => {
            failureDb.query("UPDATE jobs SET locked_by = 'other' WHERE id = $id;").run({ id: job.id });
            throw new Error("boom");
          },
          workerId: "worker_1",
        });
        assertEqual(failure.skippedStale, 1);
        failureDb.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("drains repeatedly until no due jobs remain", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedJob(db, { id: "job_1" });
        seedJob(db, { id: "job_2" });
        const result = await drainOnce({
          batchSize: 1,
          db,
          now: fixedNow([
            "2026-07-03T12:00:00.000Z",
            "2026-07-03T12:00:01.000Z",
            "2026-07-03T12:00:02.000Z",
            "2026-07-03T12:00:03.000Z",
            "2026-07-03T12:00:04.000Z",
          ]),
          processJob: async () => {},
          workerId: "worker_1",
        });
        assertEqual(result, {
          claimed: 2,
          dead: 0,
          failed: 0,
          iterations: 3,
          maxIterationsReached: false,
          released: 0,
          skippedStale: 0,
          succeeded: 2,
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
    import { mkdtempSync, rmSync, readFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { parseMigrationFile } from ${JSON.stringify(`${serviceRoot}src/db/migration-files.ts`)};
    import { openDatabase } from ${JSON.stringify(`${serviceRoot}src/db/index.ts`)};
    import { drainOnce, runOnce } from ${JSON.stringify(`${serviceRoot}src/queue/runner.ts`)};

    function createMigratedDatabase() {
      const directory = mkdtempSync(join(tmpdir(), "nusend-queue-runner-db-"));
      const db = openDatabase(join(directory, "queue.sqlite"));
      db.__temporaryDirectory = directory;
      const migration = parseMigrationFile("0001_initial_schema", readFileSync(${JSON.stringify(`${serviceRoot}src/db/migrations/sql/0001_initial_schema.sql`)}, "utf8"));
      db.run(migration.upSql);
      return db;
    }

    function closeDatabase(db) {
      const directory = db.__temporaryDirectory;
      db.close();
      rmSync(directory, { force: true, recursive: true });
    }

    function seedJob(db, options) {
      const id = options.id;
      const now = options.createdAt ?? "2026-07-03T11:00:00.000Z";
      db.query(\`
        INSERT INTO jobs (id, kind, state, run_at, attempts, max_attempts, locked_by, locked_until, ref_id, last_error, created_at, updated_at)
        VALUES ($id, $kind, $state, $runAt, $attempts, $maxAttempts, $lockedBy, $lockedUntil, $refId, NULL, $createdAt, $updatedAt);
      \`).run({
        attempts: options.attempts ?? 0,
        createdAt: now,
        id,
        kind: options.kind ?? "send_delivery",
        lockedBy: options.lockedBy ?? null,
        lockedUntil: options.lockedUntil ?? null,
        maxAttempts: options.maxAttempts ?? 10,
        refId: options.refId ?? "ref_" + id,
        runAt: options.runAt ?? "2026-07-03T11:00:00.000Z",
        state: options.state ?? "queued",
        updatedAt: now,
      });
    }

    function fixedNow(values) {
      return () => values.shift() ?? values.at(-1) ?? "2026-07-03T12:00:00.000Z";
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

    ${body.replaceAll("db.close();", "closeDatabase(db);").replaceAll("successDb.close();", "closeDatabase(successDb);").replaceAll("failureDb.close();", "closeDatabase(failureDb);")}
    console.log("OK");
  `;
}
