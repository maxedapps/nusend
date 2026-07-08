// A representative queue cycle (seed → release → claim → complete/fail/dead)
// returning a full snapshot. Run against BOTH Database layers by
// db/driver-parity.test.ts — the snapshots must be identical, guarding
// node:sqlite / bun:sqlite drift.
import { Effect, Layer, Result } from "effect";
import { TestClock } from "effect/testing";

import { readMigrationFiles } from "../db/migration-files.ts";
import type { DatabaseError } from "../errors.ts";
import {
  claimSendDeliveryJobs,
  completeSendDeliveryJob,
  failSendDeliveryJob,
  releaseExpiredSendDeliveryLeases,
} from "../queue/jobs.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { seedJob } from "./queue-fixtures.ts";

// Pass an UNMIGRATED layer — migrations are applied here through Database.exec
// so both drivers take the identical code path.
export function runDriverParityCycle(
  layer: Layer.Layer<DatabaseService, DatabaseError>,
): Promise<unknown> {
  const program = Effect.gen(function* () {
    const db = yield* Database;
    for (const parsed of readMigrationFiles()) {
      const migration = Result.getOrThrow(parsed);
      yield* db.exec(`parity:migrate:${migration.version}`, migration.upSql);
    }

    yield* db.run(
      "parity:suppression:insert",
      `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
       VALUES ('sup_1', 'User@Example.com', 'marketing', NULL, 'unsubscribe', '2026-07-03T12:00:00.000Z')
       ON CONFLICT(email, scope) WHERE list_id IS NULL DO NOTHING;`,
    );
    yield* db.run(
      "parity:suppression:insert-conflict",
      `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
       VALUES ('sup_2', 'user@example.com', 'marketing', NULL, 'unsubscribe', '2026-07-03T12:00:00.000Z')
       ON CONFLICT(email, scope) WHERE list_id IS NULL DO NOTHING;`,
    );

    yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
    yield* seedJob({ id: "complete_me" });
    yield* seedJob({ id: "dead_me", maxAttempts: 1 });
    yield* seedJob({ id: "fail_me" });
    yield* seedJob({
      attempts: 1,
      id: "expired",
      lockedBy: "old_worker",
      lockedUntil: "2026-07-03T11:59:00.000Z",
      state: "leased",
    });

    const released = yield* releaseExpiredSendDeliveryLeases({});
    const claimed = yield* claimSendDeliveryJobs({ workerId: "worker_1" });

    yield* TestClock.setTime(Date.parse("2026-07-03T12:01:00.000Z"));
    const completed = yield* completeSendDeliveryJob({
      jobId: "complete_me",
      workerId: "worker_1",
    });
    const failed = yield* failSendDeliveryJob({
      errorMessage: "parity failure",
      jobId: "fail_me",
      workerId: "worker_1",
    });
    const dead = yield* failSendDeliveryJob({
      errorMessage: "parity dead",
      jobId: "dead_me",
      workerId: "worker_1",
    });
    const stale = yield* completeSendDeliveryJob({
      jobId: "complete_me",
      workerId: "worker_1",
    }).pipe(
      Effect.map(() => "unexpected success"),
      Effect.catchTag("JobNotLeasedError", (error) => Effect.succeed(`not_leased:${error.jobId}`)),
    );

    const rows = yield* db.all(
      "parity:rows",
      `SELECT id, state, attempts, run_at AS runAt, locked_by AS lockedBy,
              locked_until AS lockedUntil, last_error AS lastError, updated_at AS updatedAt
       FROM jobs ORDER BY id;`,
    );
    const missing = yield* db.get("parity:missing", "SELECT id FROM jobs WHERE id = 'nope';");
    const suppressions = yield* db.all(
      "parity:suppressions",
      "SELECT lower(email) AS email, scope FROM suppressions ORDER BY id;",
    );

    return { claimed, completed, dead, failed, missing, released, rows, stale, suppressions };
  });

  return Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer()))));
}
