import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupBunScenarios, runBunScenario } from "../testing/bun-scenario.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => cleanupBunScenarios());

describe("queue jobs", () => {
  it("claims due queued jobs atomically with lease metadata, limit, and kind filters", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedJob(db, { id: "future", kind: "send_delivery", runAt: "2026-07-03T12:10:00.000Z" });
        seedJob(db, { id: "due_2", kind: "send_delivery", runAt: "2026-07-03T11:59:00.000Z", createdAt: "2026-07-03T11:59:01.000Z" });
        seedJob(db, { id: "event_1", kind: "process_ses_event", runAt: "2026-07-03T11:58:00.000Z" });
        seedJob(db, { id: "due_1", kind: "send_delivery", runAt: "2026-07-03T11:59:00.000Z", createdAt: "2026-07-03T11:59:00.000Z" });

        const claimed = claimJobs(db, {
          kinds: ["send_delivery"],
          leaseSeconds: 30,
          limit: 1,
          now: "2026-07-03T12:00:00.000Z",
          workerId: "worker_1",
        });

        assertEqual(claimed.map((job) => job.id), ["due_1"]);
        assertEqual(claimed[0], {
          attempts: 1,
          createdAt: "2026-07-03T11:59:00.000Z",
          id: "due_1",
          kind: "send_delivery",
          lastError: null,
          lockedBy: "worker_1",
          lockedUntil: "2026-07-03T12:00:30.000Z",
          maxAttempts: 10,
          refId: "ref_due_1",
          runAt: "2026-07-03T11:59:00.000Z",
          state: "leased",
          updatedAt: "2026-07-03T12:00:00.000Z",
        });
        assertEqual(selectAll(db, "SELECT id, state, attempts, locked_by AS lockedBy FROM jobs ORDER BY id;"), [
          { attempts: 1, id: "due_1", lockedBy: "worker_1", state: "leased" },
          { attempts: 0, id: "due_2", lockedBy: null, state: "queued" },
          { attempts: 0, id: "event_1", lockedBy: null, state: "queued" },
          { attempts: 0, id: "future", lockedBy: null, state: "queued" },
        ]);
        assertEqual(selectSingle(db, "SELECT state, attempts, locked_by AS lockedBy, locked_until AS lockedUntil FROM jobs WHERE id = 'future';"), {
          attempts: 0,
          lockedBy: null,
          lockedUntil: null,
          state: "queued",
        });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("does not claim terminal or cancelled jobs", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        for (const state of ["succeeded", "dead", "cancelled"]) {
          seedJob(db, { id: state, state });
        }
        assertEqual(claimJobs(db, { now: "2026-07-03T12:00:00.000Z", workerId: "worker_1" }), []);
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("completes only jobs leased by the owning worker", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedJob(db, { id: "job_1" });
        claimJobs(db, { now: "2026-07-03T12:00:00.000Z", workerId: "worker_1" });

        assertEqual(completeJob(db, { jobId: "job_1", now: "2026-07-03T12:01:00.000Z", workerId: "other" }), {
          ok: false,
          reason: "not_leased_by_worker",
        });
        const completed = completeJob(db, { jobId: "job_1", now: "2026-07-03T12:01:00.000Z", workerId: "worker_1" });
        assertEqual(completed.ok, true);
        assertEqual(completed.job.state, "succeeded");
        assertEqual(completed.job.lockedBy, null);
        assertEqual(completed.job.lockedUntil, null);
        assertEqual(selectSingle(db, "SELECT state, locked_by AS lockedBy, locked_until AS lockedUntil, last_error AS lastError FROM jobs WHERE id = 'job_1';"), {
          lastError: null,
          lockedBy: null,
          lockedUntil: null,
          state: "succeeded",
        });
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("requeues failed jobs with backoff and dead-letters exhausted jobs", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedJob(db, { id: "retry" });
        seedJob(db, { id: "dead", maxAttempts: 1 });
        claimJobs(db, { limit: 2, now: "2026-07-03T12:00:00.000Z", workerId: "worker_1" });

        const retry = failJob(db, {
          errorMessage: "temporary failure",
          jobId: "retry",
          now: "2026-07-03T12:01:00.000Z",
          workerId: "worker_1",
        });
        assertEqual(retry.ok, true);
        assertEqual(retry.job.state, "queued");
        assertEqual(retry.job.runAt, "2026-07-03T12:02:00.000Z");
        assertEqual(retry.job.lastError, "temporary failure");

        const dead = failJob(db, {
          errorMessage: "permanent failure",
          jobId: "dead",
          now: "2026-07-03T12:01:00.000Z",
          workerId: "worker_1",
        });
        assertEqual(dead.ok, true);
        assertEqual(dead.job.state, "dead");
        assertEqual(dead.job.lockedBy, null);
        assertEqual(dead.job.lastError, "permanent failure");
        db.close();
      `),
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("recovers expired leases with backoff or dead-letter transitions", () => {
    const result = runBunScenario(
      scenarioScript(`
        const db = createMigratedDatabase();
        seedJob(db, {
          attempts: 2,
          id: "expired_retry",
          lockedBy: "dead_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          state: "leased",
        });
        seedJob(db, {
          attempts: 2,
          id: "expired_dead",
          lockedBy: "dead_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          maxAttempts: 2,
          state: "leased",
        });
        seedJob(db, {
          attempts: 4,
          id: "expired_attempt4",
          lockedBy: "dead_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          state: "leased",
        });
        seedJob(db, {
          attempts: 1,
          id: "active_lease",
          lockedBy: "worker",
          lockedUntil: "2026-07-03T12:10:00.000Z",
          state: "leased",
        });

        const released = releaseExpiredLeases(db, { now: "2026-07-03T12:00:00.000Z" });
        assertEqual(released.map((job) => ({ id: job.id, runAt: job.runAt, state: job.state })).sort((a, b) => a.id.localeCompare(b.id)), [
          { id: "expired_attempt4", runAt: "2026-07-03T12:08:00.000Z", state: "queued" },
          { id: "expired_dead", runAt: "2026-07-03T11:00:00.000Z", state: "dead" },
          { id: "expired_retry", runAt: "2026-07-03T12:02:00.000Z", state: "queued" },
        ]);
        assertEqual(selectSingle(db, "SELECT state, locked_by AS lockedBy FROM jobs WHERE id = 'active_lease';"), {
          lockedBy: "worker",
          state: "leased",
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
    import { claimJobs, completeJob, failJob, releaseExpiredLeases } from ${JSON.stringify(`${serviceRoot}src/queue/jobs.ts`)};

    function createMigratedDatabase() {
      const directory = mkdtempSync(join(tmpdir(), "nusend-queue-db-"));
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

    ${body.replaceAll("db.close();", "closeDatabase(db);")}
    console.log("OK");
  `;
}
