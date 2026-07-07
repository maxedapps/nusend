// Migration CLI: bun src/db/migrate.ts <up|down|status>
import { ConfigProvider, Effect, Exit, ManagedRuntime, Result } from "effect";

import { serviceConfig } from "../config.ts";
import { MigrationError, type DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { DatabaseBunLive } from "../services/database-bun.ts";
import { migrationsDirectory, readMigrationFiles, type MigrationFile } from "./migration-files.ts";

type Command = "down" | "status" | "up";

type AppliedMigration = {
  checksum: string;
  version: string;
};

function parseCommand(value: string | undefined): Command {
  if (value === "up" || value === "down" || value === "status") return value;

  throw new Error("Usage: bun src/db/migrate.ts <up|down|status>");
}

const migrationFiles: Effect.Effect<MigrationFile[], MigrationError> = Effect.suspend(() => {
  const migrations: MigrationFile[] = [];
  for (const parsed of readMigrationFiles()) {
    if (Result.isFailure(parsed)) return Effect.fail(parsed.failure);
    migrations.push(parsed.success);
  }

  return Effect.succeed(migrations);
});

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

function validateAppliedMigrationFiles(
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

function mapAppliedMigrations(
  appliedMigrations: readonly AppliedMigration[],
): Map<string, AppliedMigration> {
  return new Map(appliedMigrations.map((migration) => [migration.version, migration]));
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
