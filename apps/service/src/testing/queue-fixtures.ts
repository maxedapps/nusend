import { Effect } from "effect";

import type { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";

export type SeedJobOptions = {
  id: string;
  attempts?: number;
  createdAt?: string;
  deliveryId?: string;
  lockedBy?: string | null;
  lockedUntil?: string | null;
  maxAttempts?: number;
  runAt?: string;
  state?: string;
};

export function seedJob(
  options: SeedJobOptions,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  const now = options.createdAt ?? "2026-07-03T11:00:00.000Z";

  return Effect.gen(function* () {
    const db = yield* Database;
    const deliveryId = options.deliveryId ?? `delivery_${options.id}`;
    yield* db.run(
      "seed-job:mailing",
      `INSERT OR IGNORE INTO mailings (id, purpose, state, name, subject, html, text, list_id, scheduled_at, created_at, updated_at)
       VALUES ('mailing_seed', 'transactional', 'scheduled', NULL, 'Seed', '<p>Seed</p>', NULL, NULL, $createdAt, $createdAt, $updatedAt);`,
      { createdAt: now, updatedAt: now },
    );
    yield* db.run(
      "seed-job:delivery",
      `INSERT OR IGNORE INTO deliveries (id, mailing_id, email, contact_id, vars_json, status, created_at, updated_at)
       VALUES ($deliveryId, 'mailing_seed', $email, NULL, NULL, 'queued', $createdAt, $updatedAt);`,
      { createdAt: now, deliveryId, email: `${deliveryId}@example.com`, updatedAt: now },
    );
    yield* db.run(
      "seed-job",
      `INSERT INTO jobs (id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id, last_error, created_at, updated_at)
       VALUES ($id, $state, $runAt, $attempts, $maxAttempts, $lockedBy, $lockedUntil, $deliveryId, NULL, $createdAt, $updatedAt);`,
      {
        attempts: options.attempts ?? 0,
        createdAt: now,
        deliveryId,
        id: options.id,
        lockedBy: options.lockedBy ?? null,
        lockedUntil: options.lockedUntil ?? null,
        maxAttempts: options.maxAttempts ?? 10,
        runAt: options.runAt ?? "2026-07-03T11:00:00.000Z",
        state: options.state ?? "queued",
        updatedAt: now,
      },
    );
  });
}
