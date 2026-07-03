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

    const initialStatus = runMigrationCommand("status", databasePath).stdout;
    expect(initialStatus).toContain("pending  0001_initial_schema");
    expect(initialStatus).toContain("pending  0002_auth");

    const migrateUp = runMigrationCommand("up", databasePath).stdout;
    expect(migrateUp).toContain("Applied migration 0001_initial_schema.");
    expect(migrateUp).toContain("Applied migration 0002_auth.");

    const migratedStatus = runMigrationCommand("status", databasePath).stdout;
    expect(migratedStatus).toContain("applied  0001_initial_schema");
    expect(migratedStatus).toContain("applied  0002_auth");

    expect(readTableNames(databasePath)).toEqual([
      "accounts",
      "api_keys",
      "contacts",
      "deliveries",
      "jobs",
      "list_memberships",
      "lists",
      "mailings",
      "organization_invitations",
      "organization_members",
      "organizations",
      "schema_migrations",
      "send_attempts",
      "ses_events",
      "sessions",
      "suppressions",
      "templates",
      "users",
      "verifications",
    ]);
    expect(readColumnNames(databasePath, "users")).toContain("email_verified");
    expect(readColumnNames(databasePath, "sessions")).toContain("active_organization_id");
    expect(readColumnNames(databasePath, "api_keys")).toContain("reference_id");

    const drift = runBun(
      [
        "-e",
        "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); db.run(\"UPDATE schema_migrations SET checksum = 'changed' WHERE version = '0001_initial_schema';\"); db.close();",
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
        "import { Database } from 'bun:sqlite'; import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; const db = new Database(process.env.NUSEND_DB_PATH, { strict: true }); const content = readFileSync('src/db/migrations/sql/0001_initial_schema.sql', 'utf8'); const checksum = createHash('sha256').update(content).digest('hex'); db.query(\"UPDATE schema_migrations SET checksum = $checksum WHERE version = '0001_initial_schema';\").run({ checksum }); db.close();",
      ],
      databasePath,
    );
    expect(restore.status).toBe(0);

    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0002_auth.",
    );
    expect(readTableNames(databasePath)).not.toContain("users");

    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0001_initial_schema.",
    );
    expect(readTableNames(databasePath)).toEqual(["schema_migrations"]);
    expect(runMigrationCommand("up", databasePath).stdout).toContain(
      "Applied migration 0002_auth.",
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

function readColumnNames(databasePath: string, tableName: string): string[] {
  const result = runBun(
    [
      "-e",
      `import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); const rows = db.query("PRAGMA table_info(${tableName});").all(); console.log(JSON.stringify(rows.map((row) => row.name))); db.close();`,
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
