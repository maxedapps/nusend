// Migration CLI: bun src/db/migrate.ts <up|down|status>
import { ConfigProvider, Effect, Exit, ManagedRuntime } from "effect";

import { serviceConfig } from "../config.ts";
import { MigrationError, type DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { DatabaseBunLive } from "../services/database-bun.ts";
import {
  mapAppliedMigrations,
  migrationFiles,
  validateAppliedMigrationFiles,
  type AppliedMigration,
} from "./migration-check.ts";
import { droppedTableNames } from "./destructive-migration.ts";
import { type MigrationFile } from "./migration-files.ts";

type Command = "down" | "status" | "up";

function parseCommand(value: string | undefined): Command {
  if (value === "up" || value === "down" || value === "status") return value;

  throw new Error("Usage: bun src/db/migrate.ts <up|down|status>");
}

function migrationProgram(
  command: Command,
): Effect.Effect<void, DatabaseError | MigrationError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;

    yield* db.exec(
      "migrate:ensure-table",
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );`,
    );

    const migrations = yield* migrationFiles;
    const appliedMigrations = yield* db.all<AppliedMigration>(
      "migrate:read-applied",
      "SELECT version, checksum FROM schema_migrations ORDER BY version ASC;",
    );

    if (command === "up") return yield* migrateUp(db, migrations, appliedMigrations);
    if (command === "down") return yield* migrateDown(db, migrations, appliedMigrations);
    printStatus(migrations, appliedMigrations);
  });
}

function migrateUp(
  db: DatabaseService,
  migrations: MigrationFile[],
  appliedMigrations: readonly AppliedMigration[],
): Effect.Effect<void, DatabaseError | MigrationError> {
  return Effect.gen(function* () {
    const appliedByVersion = mapAppliedMigrations(appliedMigrations);
    yield* validateAppliedMigrationFiles(migrations, appliedByVersion);

    const pendingMigrations = migrations.filter(
      (migration) => !appliedByVersion.has(migration.version),
    );

    if (pendingMigrations.length === 0) {
      console.log("No pending migrations.");
      return;
    }

    for (const migration of pendingMigrations) {
      yield* db.transaction(
        Effect.gen(function* () {
          yield* db.exec(`migrate:apply:${migration.version}`, migration.upSql);
          yield* db.run(
            "migrate:record",
            "INSERT INTO schema_migrations (version, checksum) VALUES ($version, $checksum);",
            { checksum: migration.checksum, version: migration.version },
          );
        }),
      );
      console.log(`Applied migration ${migration.version}.`);
    }
  });
}

function migrateDown(
  db: DatabaseService,
  migrations: MigrationFile[],
  appliedMigrations: readonly AppliedMigration[],
): Effect.Effect<void, DatabaseError | MigrationError> {
  return Effect.gen(function* () {
    if (appliedMigrations.length === 0) {
      console.log("No applied migrations to roll back.");
      return;
    }

    const latestApplied = [...appliedMigrations].sort((left, right) =>
      right.version.localeCompare(left.version),
    )[0];
    const migration = migrations.find((candidate) => candidate.version === latestApplied.version);

    if (!migration) {
      return yield* Effect.fail(
        new MigrationError({
          reason: `Cannot roll back ${latestApplied.version}: migration file is missing.`,
          version: latestApplied.version,
        }),
      );
    }

    if (migration.checksum !== latestApplied.checksum) {
      return yield* Effect.fail(
        new MigrationError({
          reason: `Cannot roll back ${migration.version}: migration checksum changed after it was applied.`,
          version: migration.version,
        }),
      );
    }

    // Destructive-rollback gate: a down migration that DROPs a table destroys that
    // table's data. Require explicit confirmation so an accidental `db:rollback`
    // does not silently delete e.g. the SES audit trail or all API keys.
    const droppedTables = yield* Effect.try({
      try: () => droppedTableNames(migration.downSql),
      catch: (cause) =>
        new MigrationError({
          reason: `Cannot inspect destructive rollback ${migration.version}: ${cause instanceof Error ? cause.message : "malformed DROP TABLE statement"}`,
          version: migration.version,
        }),
    });
    if (droppedTables.length > 0) {
      console.log(`Destructive rollback tables: ${droppedTables.join(", ")}`);
    }
    if (droppedTables.length > 0 && process.env.NUSEND_CONFIRM_DESTRUCTIVE_ROLLBACK !== "1") {
      return yield* Effect.fail(
        new MigrationError({
          reason: `Rolling back ${migration.version} drops data-bearing table(s): ${droppedTables.join(
            ", ",
          )}. Re-run with NUSEND_CONFIRM_DESTRUCTIVE_ROLLBACK=1 to confirm.`,
          version: migration.version,
        }),
      );
    }

    yield* db.transaction(
      Effect.gen(function* () {
        yield* db.exec(`migrate:rollback:${migration.version}`, migration.downSql);
        yield* db.run(
          "migrate:unrecord",
          "DELETE FROM schema_migrations WHERE version = $version;",
          { version: migration.version },
        );
      }),
    );
    console.log(`Rolled back migration ${migration.version}.`);
  });
}

function printStatus(
  migrations: MigrationFile[],
  appliedMigrations: readonly AppliedMigration[],
): void {
  const appliedByVersion = mapAppliedMigrations(appliedMigrations);
  const migrationVersions = new Set(migrations.map((migration) => migration.version));

  for (const migration of migrations) {
    const applied = appliedByVersion.get(migration.version);
    const state = !applied
      ? "pending"
      : applied.checksum === migration.checksum
        ? "applied"
        : "changed";

    console.log(`${state.padEnd(8)} ${migration.version}`);
  }

  for (const applied of appliedMigrations) {
    if (!migrationVersions.has(applied.version)) {
      console.log(`missing  ${applied.version}`);
    }
  }
}

const command = (() => {
  try {
    return parseCommand(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();
const config = await Effect.runPromise(
  serviceConfig.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
  ),
).catch((error: unknown) => {
  console.error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
  return process.exit(1);
});
const runtime = ManagedRuntime.make(DatabaseBunLive(config.databasePath));

try {
  const exit = await runtime.runPromiseExit(
    migrationProgram(command).pipe(
      Effect.map(() => 0),
      Effect.catchTags({
        DatabaseError: (error) =>
          Effect.sync(() => {
            console.error(`Database error during ${error.operation}: ${String(error.cause)}`);
            return 1;
          }),
        MigrationError: (error) =>
          Effect.sync(() => {
            console.error(error.reason);
            return 1;
          }),
      }),
    ),
  );

  if (Exit.isSuccess(exit)) {
    if (exit.value !== 0) process.exitCode = exit.value;
  } else {
    console.error(String(exit.cause));
    process.exitCode = 1;
  }
} finally {
  await runtime.dispose();
}
