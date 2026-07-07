import { Effect } from "effect";

import type { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";

export type SeedJobOptions = {
  id: string;
  attempts?: number;
  createdAt?: string;
  kind?: string;
  lockedBy?: string | null;
  lockedUntil?: string | null;
  maxAttempts?: number;
  refId?: string;
  runAt?: string;
  state?: string;
};

export function seedJob(
  options: SeedJobOptions,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  const now = options.createdAt ?? "2026-07-03T11:00:00.000Z";

  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.run(
      "seed-job",
      `INSERT INTO jobs (id, kind, state, run_at, attempts, max_attempts, locked_by, locked_until, ref_id, last_error, created_at, updated_at)
       VALUES ($id, $kind, $state, $runAt, $attempts, $maxAttempts, $lockedBy, $lockedUntil, $refId, NULL, $createdAt, $updatedAt);`,
      {
        attempts: options.attempts ?? 0,
        createdAt: now,
        id: options.id,
        kind: options.kind ?? "send_delivery",
        lockedBy: options.lockedBy ?? null,
        lockedUntil: options.lockedUntil ?? null,
        maxAttempts: options.maxAttempts ?? 10,
        refId: options.refId ?? `ref_${options.id}`,
        runAt: options.runAt ?? "2026-07-03T11:00:00.000Z",
        state: options.state ?? "queued",
        updatedAt: now,
      },
    );
  });
}
