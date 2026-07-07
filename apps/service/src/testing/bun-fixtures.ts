// Helpers imported by bun-scenario scripts (they run under Bun, so bun:sqlite is
// available). Not used by in-process vitest tests.
import { Database as BunDatabase } from "bun:sqlite";
import { Result } from "effect";

import { readMigrationFiles } from "../db/migration-files.ts";

export function createMigratedBunDatabase(): BunDatabase {
  const db = new BunDatabase(":memory:", { create: true, strict: true });
  db.run("PRAGMA foreign_keys = ON;");

  for (const parsed of readMigrationFiles()) {
    db.run(Result.getOrThrow(parsed).upSql);
  }

  return db;
}

// Seeds the owner/workspace rows that `bootstrapOwner` would create, for scenarios
// that need an existing owner without running the bootstrap program.
export function seedOwner(
  db: BunDatabase,
  input: { email: string; name: string; slug: string; workspace: string },
): { organizationId: string; userId: string } {
  const now = "2026-07-03T12:00:00.000Z";
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();

  db.query(
    `INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at)
     VALUES ($id, $name, $email, 1, NULL, $now, $now);`,
  ).run({ email: input.email.trim().toLowerCase(), id: userId, name: input.name, now });
  db.query(
    `INSERT INTO organizations (id, name, slug, logo, created_at, metadata)
     VALUES ($id, $name, $slug, NULL, $now, NULL);`,
  ).run({ id: organizationId, name: input.workspace, now, slug: input.slug });
  db.query(
    `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
     VALUES ($id, $organizationId, $userId, 'owner', $now);`,
  ).run({ id: crypto.randomUUID(), now, organizationId, userId });

  return { organizationId, userId };
}
