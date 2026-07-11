// Node-safe migration validation shared by the migrate CLI and the service /
// worker startup guards. Kept separate from migrate.ts so importers do not pull
// in database-bun.ts (bun:sqlite), which fails under node:sqlite test runs.
import { Cause, Effect, Option, Result } from "effect";

import { MigrationError, type DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { migrationsDirectory, readMigrationFiles, type MigrationFile } from "./migration-files.ts";

export type AppliedMigration = {
  checksum: string;
  version: string;
};

export const migrationFiles: Effect.Effect<MigrationFile[], MigrationError> = Effect.suspend(() => {
  const migrations: MigrationFile[] = [];
  for (const parsed of readMigrationFiles()) {
    if (Result.isFailure(parsed)) return Effect.fail(parsed.failure);
    migrations.push(parsed.success);
  }

  return Effect.succeed(migrations);
});

export function mapAppliedMigrations(
  appliedMigrations: readonly AppliedMigration[],
): Map<string, AppliedMigration> {
  return new Map(appliedMigrations.map((migration) => [migration.version, migration]));
}

export function validateAppliedMigrationFiles(
  migrations: MigrationFile[],
  appliedByVersion: Map<string, AppliedMigration>,
): Effect.Effect<void, MigrationError> {
  return Effect.gen(function* () {
    const migrationsByVersion = new Map(
      migrations.map((migration) => [migration.version, migration]),
    );

    for (const applied of appliedByVersion.values()) {
      const migration = migrationsByVersion.get(applied.version);

      if (!migration) {
        return yield* Effect.fail(
          new MigrationError({
            reason: `Applied migration ${applied.version} is missing from ${migrationsDirectory}.`,
            version: applied.version,
          }),
        );
      }

      if (migration.checksum !== applied.checksum) {
        return yield* Effect.fail(
          new MigrationError({
            reason: `Applied migration ${applied.version} checksum changed. Roll it back before editing it.`,
            version: applied.version,
          }),
        );
      }
    }
  });
}

// Startup guard reused by the service and worker entrypoints: fail fast if any
// migration is pending, missing, or checksum-drifted, so a fresh/empty database
// (e.g. a mistyped NUSEND_DB_PATH the driver silently created) or a forgotten
// db:migrate does not surface as every route/worker cycle failing with
// "no such table". Read-only — never creates or applies anything.
export function assertMigrationsUpToDate(): Effect.Effect<
  void,
  DatabaseError | MigrationError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const migrations = yield* migrationFiles;

    const tableExists = yield* db.get<{ name: string }>(
      "migrate:check-table",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations';",
    );
    const appliedMigrations = tableExists
      ? yield* db.all<AppliedMigration>(
          "migrate:read-applied",
          "SELECT version, checksum FROM schema_migrations ORDER BY version ASC;",
        )
      : [];

    const appliedByVersion = mapAppliedMigrations(appliedMigrations);
    yield* validateAppliedMigrationFiles(migrations, appliedByVersion);

    const pending = migrations.filter((migration) => !appliedByVersion.has(migration.version));
    if (pending.length > 0) {
      return yield* Effect.fail(
        new MigrationError({
          reason: `Database has ${pending.length} pending migration(s): ${pending
            .map((migration) => migration.version)
            .join(", ")}. Run \`pnpm --filter @nusend/service db:migrate\`.`,
          version: pending[0].version,
        }),
      );
    }
  });
}

// Extracts a human-readable reason from a migration-check failure cause for the
// entrypoints' fail-fast logging.
export function describeStartupMigrationFailure(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    if (error instanceof MigrationError) return error.reason;
  }
  return "database migration validation failed";
}
