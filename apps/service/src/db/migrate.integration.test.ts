import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(initialStatus).toContain("pending  0002_simplify_send_queue_and_states");
    expect(initialStatus).toContain("pending  0003_ses_feedback_ingestion");

    const migrateUp = runMigrationCommand("up", databasePath).stdout;
    expect(migrateUp).toContain("Applied migration 0001_initial_schema.");
    expect(migrateUp).toContain("Applied migration 0002_simplify_send_queue_and_states.");
    expect(migrateUp).toContain("Applied migration 0003_ses_feedback_ingestion.");

    const migratedStatus = runMigrationCommand("status", databasePath).stdout;
    expect(migratedStatus).toContain("applied  0001_initial_schema");
    expect(migratedStatus).toContain("applied  0002_simplify_send_queue_and_states");
    expect(migratedStatus).toContain("applied  0003_ses_feedback_ingestion");

    expect(readTableNames(databasePath)).toEqual([
      "accounts",
      "api_keys",
      "contacts",
      "deliveries",
      "jobs",
      "list_memberships",
      "lists",
      "mailing_idempotency_keys",
      "mailings",
      "schema_migrations",
      "send_attempts",
      "ses_feedback_notifications",
      "ses_feedback_recipients",
      "sessions",
      "suppressions",
      "users",
      "verifications",
    ]);
    expect(readColumnNames(databasePath, "users")).toContain("email_verified");
    expect(readColumnNames(databasePath, "sessions")).not.toContain("active_organization_id");
    expect(readColumnNames(databasePath, "contacts")).not.toContain("attrs_json");
    expect(readColumnNames(databasePath, "api_keys")).toContain("reference_id");
    expect(readColumnNames(databasePath, "deliveries")).toEqual(
      expect.arrayContaining(["ses_message_id", "last_error"]),
    );
    expect(readColumnNames(databasePath, "jobs")).not.toContain("kind");
    expect(readColumnNames(databasePath, "jobs")).toContain("delivery_id");
    expect(readColumnNames(databasePath, "send_attempts")).toEqual(
      expect.arrayContaining(["delivery_id", "job_id", "attempt_no", "status"]),
    );
    expect(readColumnNames(databasePath, "mailing_idempotency_keys")).toEqual(
      expect.arrayContaining(["key", "request_hash", "mailing_id", "response_json"]),
    );
    expect(readColumnNames(databasePath, "ses_feedback_notifications")).toEqual(
      expect.arrayContaining(["sns_message_id", "raw_json", "received_at"]),
    );
    expect(readColumnNames(databasePath, "ses_feedback_recipients")).toEqual(
      expect.arrayContaining(["sns_message_id", "recipient_email", "action_taken"]),
    );
    expect(readIndexNames(databasePath, "ses_feedback_recipients")).toEqual(
      expect.arrayContaining([
        "ses_feedback_recipients_delivery_id_idx",
        "ses_feedback_recipients_ses_message_id_idx",
        "ses_feedback_recipients_email_idx",
        "ses_feedback_recipients_event_created_idx",
      ]),
    );
    expect(readTableSql(databasePath, "ses_feedback_recipients")).toContain(
      "action_taken IN ('recorded', 'suppressed', 'ignored')",
    );

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
      "Rolled back migration 0003_ses_feedback_ingestion.",
    );
    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0002_simplify_send_queue_and_states.",
    );
    expect(readColumnNames(databasePath, "jobs")).toContain("kind");
    expect(readColumnNames(databasePath, "jobs")).toContain("ref_id");
    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0001_initial_schema.",
    );
    expect(readTableNames(databasePath)).toEqual(["schema_migrations"]);
    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "No applied migrations to roll back.",
    );
    const migrateUpAgain = runMigrationCommand("up", databasePath).stdout;
    expect(migrateUpAgain).toContain("Applied migration 0001_initial_schema.");
    expect(migrateUpAgain).toContain("Applied migration 0002_simplify_send_queue_and_states.");
    expect(migrateUpAgain).toContain("Applied migration 0003_ses_feedback_ingestion.");

    const synthetic = runBun(
      [
        "-e",
        "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); db.run(\"INSERT INTO schema_migrations (version, checksum) VALUES ('9999_missing', 'no-such-file');\"); db.close();",
      ],
      databasePath,
    );
    expect(synthetic.status).toBe(0);

    expect(runMigrationCommand("status", databasePath).stdout).toContain("missing  9999_missing");

    const upWithMissingFile = runMigrationCommand("up", databasePath);
    expect(upWithMissingFile.status).not.toBe(0);
    expect(upWithMissingFile.stderr).toContain("Applied migration 9999_missing is missing from");

    const downWithMissingFile = runMigrationCommand("down", databasePath);
    expect(downWithMissingFile.status).not.toBe(0);
    expect(downWithMissingFile.stderr).toContain(
      "Cannot roll back 9999_missing: migration file is missing.",
    );
  });

  it("fails loudly when 0002 sees future-only mailing states", () => {
    const databasePath = createTemporaryDatabasePath();
    const seeded = runBun(
      [
        "-e",
        `import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
const db = new Database(process.env.NUSEND_DB_PATH, { strict: true });
const content = readFileSync('src/db/migrations/sql/0001_initial_schema.sql', 'utf8');
const upSql = content.split(/\\n--\\s*migrate:down\\s*\\n/i)[0].replace(/^\\s*--\\s*migrate:up\\s*/i, '');
const checksum = createHash('sha256').update(content).digest('hex');
db.exec(\`CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);\`);
db.exec(upSql);
db.query("INSERT INTO schema_migrations (version, checksum) VALUES ('0001_initial_schema', $checksum);").run({ checksum });
db.query(\`INSERT INTO mailings (id, purpose, state, subject, html, created_at, updated_at)
  VALUES ('mailing_future_state', 'transactional', 'draft', 'Subject', '<p>Hello</p>', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');\`).run();
db.close();`,
      ],
      databasePath,
    );
    expect(seeded.status).toBe(0);

    const result = runMigrationCommand("up", databasePath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Database error during migrate:apply:0002_simplify_send_queue_and_states",
    );
    expect(runMigrationCommand("status", databasePath).stdout).toContain(
      "pending  0002_simplify_send_queue_and_states",
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

function readIndexNames(databasePath: string, tableName: string): string[] {
  const result = runBun(
    [
      "-e",
      `import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); const rows = db.query("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = '${tableName}' ORDER BY name;").all(); console.log(JSON.stringify(rows.map((row) => row.name))); db.close();`,
    ],
    databasePath,
  );

  expect(result.status).toBe(0);

  return JSON.parse(result.stdout) as string[];
}

function readTableSql(databasePath: string, tableName: string): string {
  const result = runBun(
    [
      "-e",
      `import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); const row = db.query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '${tableName}';").get(); console.log(row.sql); db.close();`,
    ],
    databasePath,
  );

  expect(result.status).toBe(0);

  return result.stdout;
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
