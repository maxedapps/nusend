import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("migration runner", () => {
  it("applies, reports, rolls back, and rejects checksum drift", () => {
    const databasePath = createTemporaryDatabasePath();

    expect(runMigrationCommand("status", databasePath).stdout).toContain(
      "pending  0001_initial_schema",
    );
    expect(runMigrationCommand("up", databasePath).stdout).toContain(
      "Applied migration 0001_initial_schema.",
    );
    expect(runMigrationCommand("status", databasePath).stdout).toContain(
      "applied  0001_initial_schema",
    );
    expect(readTableNames(databasePath)).toEqual([
      "contacts",
      "deliveries",
      "jobs",
      "list_memberships",
      "lists",
      "mailings",
      "schema_migrations",
      "send_attempts",
      "ses_events",
      "suppressions",
      "templates",
    ]);

    const drift = runBun(
      [
        "-e",
        "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); db.run(\"UPDATE schema_migrations SET checksum = 'changed';\"); db.close();",
      ],
      databasePath,
    );
    expect(drift.status).toBe(0);

    const driftResult = runMigrationCommand("up", databasePath);

    expect(driftResult.status).not.toBe(0);
    expect(driftResult.stderr).toContain("checksum changed");

    const restore = runBun(
      [
        "-e",
        "import { Database } from 'bun:sqlite'; import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; const db = new Database(process.env.NUSEND_DB_PATH, { strict: true }); const content = readFileSync('src/db/migrations/sql/0001_initial_schema.sql', 'utf8'); const checksum = createHash('sha256').update(content).digest('hex'); db.query(\"UPDATE schema_migrations SET checksum = $checksum;\").run({ checksum }); db.close();",
      ],
      databasePath,
    );
    expect(restore.status).toBe(0);

    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0001_initial_schema.",
    );
    expect(readTableNames(databasePath)).toEqual(["schema_migrations"]);
    expect(runMigrationCommand("up", databasePath).stdout).toContain(
      "Applied migration 0001_initial_schema.",
    );
  });
});

function createTemporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nusend-migrate-"));
  temporaryDirectories.push(directory);

  return join(directory, "nusend.sqlite");
}

function runMigrationCommand(command: "down" | "status" | "up", databasePath: string) {
  return runBun(["src/db/migrate.ts", command], databasePath);
}

function readTableNames(databasePath: string): string[] {
  const result = runBun(
    [
      "-e",
      "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); const rows = db.query(\"SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;\").all(); console.log(JSON.stringify(rows.map((row) => row.name))); db.close();",
    ],
    databasePath,
  );

  expect(result.status).toBe(0);

  return JSON.parse(result.stdout) as string[];
}

function runBun(args: string[], databasePath: string) {
  return spawnSync("bun", args, {
    cwd: serviceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NUSEND_DB_PATH: databasePath,
    },
  });
}
