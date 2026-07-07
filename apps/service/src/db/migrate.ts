import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.ts";
import { closeDatabase, openDatabase } from "./index.ts";
import { parseMigrationFile, type MigrationFile } from "./migration-files.ts";

type Command = "down" | "status" | "up";

type AppliedMigration = {
  checksum: string;
  version: string;
};

const migrationsDirectory = fileURLToPath(new URL("./migrations/sql/", import.meta.url));

const command = parseCommand(process.argv[2]);
const config = loadConfig();
const database = openDatabase(config.databasePath);

try {
  runCommand(database, command);
} finally {
  closeDatabase(database);
}

function parseCommand(value: string | undefined): Command {
  if (value === "up" || value === "down" || value === "status") return value;

  throw new Error("Usage: bun src/db/migrate.ts <up|down|status>");
}

function runCommand(db: Database, selectedCommand: Command): void {
  ensureSchemaMigrationsTable(db);

  const migrations = readMigrationFiles();
  const appliedMigrations = readAppliedMigrations(db);

  if (selectedCommand === "up") {
    migrateUp(db, migrations, appliedMigrations);
    return;
  }

  if (selectedCommand === "down") {
    migrateDown(db, migrations, appliedMigrations);
    return;
  }

  printStatus(migrations, appliedMigrations);
}

function ensureSchemaMigrationsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

function readMigrationFiles(): MigrationFile[] {
  if (!existsSync(migrationsDirectory)) return [];

  return readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => {
      const path = join(migrationsDirectory, fileName);
      const content = readFileSync(path, "utf8");

      return parseMigrationFile(basename(fileName, ".sql"), content);
    });
}

function readAppliedMigrations(db: Database): AppliedMigration[] {
  return db
    .query("SELECT version, checksum FROM schema_migrations ORDER BY version ASC;")
    .all() as AppliedMigration[];
}

function migrateUp(
  db: Database,
  migrations: MigrationFile[],
  appliedMigrations: AppliedMigration[],
): void {
  const appliedByVersion = mapAppliedMigrations(appliedMigrations);
  validateAppliedMigrationFiles(migrations, appliedByVersion);

  const pendingMigrations = migrations.filter(
    (migration) => !appliedByVersion.has(migration.version),
  );

  if (pendingMigrations.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  for (const migration of pendingMigrations) {
    const applyMigration = db.transaction(() => {
      db.run(migration.upSql);
      db.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($version, $checksum);",
      ).run({
        checksum: migration.checksum,
        version: migration.version,
      });
    });

    applyMigration.immediate();
    console.log(`Applied migration ${migration.version}.`);
  }
}

function migrateDown(
  db: Database,
  migrations: MigrationFile[],
  appliedMigrations: AppliedMigration[],
): void {
  if (appliedMigrations.length === 0) {
    console.log("No applied migrations to roll back.");
    return;
  }

  const latestApplied = [...appliedMigrations].sort((left, right) =>
    right.version.localeCompare(left.version),
  )[0];
  const migration = migrations.find((candidate) => candidate.version === latestApplied.version);

  if (!migration) {
    throw new Error(`Cannot roll back ${latestApplied.version}: migration file is missing.`);
  }

  if (migration.checksum !== latestApplied.checksum) {
    throw new Error(
      `Cannot roll back ${migration.version}: migration checksum changed after it was applied.`,
    );
  }

  const rollBackMigration = db.transaction(() => {
    db.run(migration.downSql);
    db.query("DELETE FROM schema_migrations WHERE version = $version;").run({
      version: migration.version,
    });
  });

  rollBackMigration.immediate();
  console.log(`Rolled back migration ${migration.version}.`);
}

function printStatus(migrations: MigrationFile[], appliedMigrations: AppliedMigration[]): void {
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
): void {
  const migrationsByVersion = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );

  for (const applied of appliedByVersion.values()) {
    const migration = migrationsByVersion.get(applied.version);

    if (!migration) {
      throw new Error(
        `Applied migration ${applied.version} is missing from ${migrationsDirectory}.`,
      );
    }

    if (migration.checksum !== applied.checksum) {
      throw new Error(
        `Applied migration ${applied.version} checksum changed. Roll it back before editing it.`,
      );
    }
  }
}

function mapAppliedMigrations(
  appliedMigrations: AppliedMigration[],
): Map<string, AppliedMigration> {
  return new Map(appliedMigrations.map((migration) => [migration.version, migration]));
}
