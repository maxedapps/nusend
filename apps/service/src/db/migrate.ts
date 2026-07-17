// Migration CLI: bun src/db/migrate.ts <up|status>
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
import { type MigrationFile } from "./migration-files.ts";

type Command = "status" | "up";

function parseCommand(value: string | undefined): Command {
  if (value === "up" || value === "status") return value;

  throw new Error("Usage: bun src/db/migrate.ts <up|status>");
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
          yield* db.exec(`migrate:apply:${migration.version}`, migration.sql);
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
