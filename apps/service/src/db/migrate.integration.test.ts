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
    expect(initialStatus).toContain("pending  0004_ses_operations_and_tracking");
    expect(initialStatus).toContain("pending  0005_first_party_api_keys_and_device_auth");
    expect(initialStatus).toContain("pending  0006_device_auth_throttle_cleanup");
    expect(initialStatus).toContain("pending  0007_mailings_created_id_index");
    expect(initialStatus).toContain("pending  0008_operations_pagination_and_job_uniqueness");

    const migrateUp = runMigrationCommand("up", databasePath).stdout;
    expect(migrateUp).toContain("Applied migration 0001_initial_schema.");
    expect(migrateUp).toContain("Applied migration 0002_simplify_send_queue_and_states.");
    expect(migrateUp).toContain("Applied migration 0003_ses_feedback_ingestion.");
    expect(migrateUp).toContain("Applied migration 0004_ses_operations_and_tracking.");
    expect(migrateUp).toContain("Applied migration 0005_first_party_api_keys_and_device_auth.");
    expect(migrateUp).toContain("Applied migration 0006_device_auth_throttle_cleanup.");
    expect(migrateUp).toContain("Applied migration 0007_mailings_created_id_index.");
    expect(migrateUp).toContain("Applied migration 0008_operations_pagination_and_job_uniqueness.");

    const migratedStatus = runMigrationCommand("status", databasePath).stdout;
    expect(migratedStatus).toContain("applied  0001_initial_schema");
    expect(migratedStatus).toContain("applied  0002_simplify_send_queue_and_states");
    expect(migratedStatus).toContain("applied  0003_ses_feedback_ingestion");
    expect(migratedStatus).toContain("applied  0004_ses_operations_and_tracking");
    expect(migratedStatus).toContain("applied  0005_first_party_api_keys_and_device_auth");
    expect(migratedStatus).toContain("applied  0006_device_auth_throttle_cleanup");
    expect(migratedStatus).toContain("applied  0007_mailings_created_id_index");
    expect(migratedStatus).toContain("applied  0008_operations_pagination_and_job_uniqueness");

    // 0008 keyset + uniqueness indexes.
    expect(readIndexNames(databasePath, "ses_events")).toContain("ses_events_created_id_idx");
    expect(readIndexNames(databasePath, "deliveries")).toContain("deliveries_created_id_idx");
    expect(readIndexNames(databasePath, "jobs")).toContain("jobs_delivery_id_unique_idx");

    expect(readTableNames(databasePath)).toEqual([
      "accounts",
      "api_keys",
      "contacts",
      "deliveries",
      "device_authorizations",
      "jobs",
      "list_memberships",
      "lists",
      "mailing_idempotency_keys",
      "mailings",
      "schema_migrations",
      "send_attempts",
      "ses_events",
      "ses_notifications",
      "ses_simulator_runs",
      "sessions",
      "suppressions",
      "users",
      "verifications",
      "worker_runs",
    ]);
    expect(readColumnNames(databasePath, "users")).toContain("email_verified");
    expect(readColumnNames(databasePath, "sessions")).not.toContain("active_organization_id");
    expect(readColumnNames(databasePath, "contacts")).not.toContain("attrs_json");
    expect(readColumnNames(databasePath, "api_keys")).toEqual(
      expect.arrayContaining([
        "user_id",
        "key_hash",
        "key_preview",
        "permissions_json",
        "revoked_at",
      ]),
    );
    expect(readColumnNames(databasePath, "api_keys")).not.toContain("reference_id");
    expect(readColumnNames(databasePath, "device_authorizations")).toEqual(
      expect.arrayContaining([
        "device_code_hash",
        "user_code_hash",
        "requested_permissions_json",
        "poll_count",
        "requester_fingerprint_hash",
      ]),
    );
    expect(readColumnNames(databasePath, "device_authorizations")).not.toEqual(
      expect.arrayContaining(["user_code_attempts", "last_user_code_attempt_at"]),
    );
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
    expect(readColumnNames(databasePath, "ses_notifications")).toEqual(
      expect.arrayContaining(["id", "sns_message_id", "raw_json", "received_at"]),
    );
    expect(readColumnNames(databasePath, "ses_events")).toEqual(
      expect.arrayContaining(["dedupe_key", "recipient_email", "action_taken", "link_url"]),
    );
    expect(readColumnNames(databasePath, "ses_simulator_runs")).toEqual(
      expect.arrayContaining(["scenario", "mode", "status", "expected_event_type"]),
    );
    expect(readColumnNames(databasePath, "worker_runs")).toEqual(
      expect.arrayContaining(["worker_id", "claimed", "skipped_stale", "finished_at"]),
    );
    expect(readIndexNames(databasePath, "api_keys")).toEqual(
      expect.arrayContaining([
        "api_keys_user_id_idx",
        "api_keys_revoked_at_idx",
        "api_keys_last_used_at_idx",
      ]),
    );
    expect(readIndexNames(databasePath, "device_authorizations")).toEqual(
      expect.arrayContaining([
        "device_authorizations_expires_at_idx",
        "device_authorizations_approved_user_idx",
      ]),
    );
    expect(readIndexNames(databasePath, "mailings")).toContain("mailings_created_id_idx");
    expect(readIndexNames(databasePath, "ses_events")).toEqual(
      expect.arrayContaining([
        "ses_events_delivery_id_idx",
        "ses_events_ses_message_id_idx",
        "ses_events_recipient_email_idx",
        "ses_events_event_created_idx",
      ]),
    );
    expect(readTableSql(databasePath, "ses_events")).toContain(
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
      "Rolled back migration 0008_operations_pagination_and_job_uniqueness.",
    );
    expect(readIndexNames(databasePath, "jobs")).not.toContain("jobs_delivery_id_unique_idx");
    expect(readIndexNames(databasePath, "ses_events")).not.toContain("ses_events_created_id_idx");
    expect(readIndexNames(databasePath, "deliveries")).not.toContain("deliveries_created_id_idx");
    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0007_mailings_created_id_index.",
    );
    expect(readIndexNames(databasePath, "mailings")).not.toContain("mailings_created_id_idx");
    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0006_device_auth_throttle_cleanup.",
    );
    expect(readColumnNames(databasePath, "device_authorizations")).toEqual(
      expect.arrayContaining(["user_code_attempts", "last_user_code_attempt_at"]),
    );
    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0005_first_party_api_keys_and_device_auth.",
    );
    expect(readColumnNames(databasePath, "api_keys")).toContain("reference_id");
    expect(readTableNames(databasePath)).not.toContain("device_authorizations");
    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0004_ses_operations_and_tracking.",
    );
    expect(readTableNames(databasePath)).toEqual(
      expect.arrayContaining(["ses_feedback_notifications", "ses_feedback_recipients"]),
    );
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
    expect(migrateUpAgain).toContain("Applied migration 0004_ses_operations_and_tracking.");
    expect(migrateUpAgain).toContain(
      "Applied migration 0005_first_party_api_keys_and_device_auth.",
    );
    expect(migrateUpAgain).toContain("Applied migration 0006_device_auth_throttle_cleanup.");
    expect(migrateUpAgain).toContain("Applied migration 0007_mailings_created_id_index.");
    expect(migrateUpAgain).toContain(
      "Applied migration 0008_operations_pagination_and_job_uniqueness.",
    );
    expect(readIndexNames(databasePath, "ses_events")).toContain("ses_events_created_id_idx");
    expect(readIndexNames(databasePath, "deliveries")).toContain("deliveries_created_id_idx");
    expect(readIndexNames(databasePath, "jobs")).toContain("jobs_delivery_id_unique_idx");

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
  }, 20_000);

  it("gates a destructive rollback behind NUSEND_CONFIRM_DESTRUCTIVE_ROLLBACK", () => {
    const databasePath = createTemporaryDatabasePath();
    expect(runMigrationCommand("up", databasePath).status).toBe(0);

    // Roll back the index-only migrations (not gated) down to 0005, whose down
    // section drops data-bearing tables (device_authorizations, api_keys).
    expect(runMigrationCommand("down", databasePath).status).toBe(0); // 0008 (indexes)
    expect(runMigrationCommand("down", databasePath).status).toBe(0); // 0007 (index)
    expect(runMigrationCommand("down", databasePath).status).toBe(0); // 0006 (indexes)

    // Without confirmation, the destructive 0005 rollback is refused.
    const refused = runMigrationCommand("down", databasePath, {
      NUSEND_CONFIRM_DESTRUCTIVE_ROLLBACK: "",
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain(
      "Destructive rollback tables: api_keys, device_authorizations",
    );
    expect(refused.stderr).toContain("drops data-bearing table(s)");
    expect(refused.stderr).toContain("device_authorizations");
    expect(readTableNames(databasePath)).toContain("device_authorizations");
    expect(readColumnNames(databasePath, "api_keys")).toContain("permissions_json");

    // With confirmation, it prints the same inventory before execution.
    const confirmed = runMigrationCommand("down", databasePath);
    expect(confirmed.status).toBe(0);
    const inventoryIndex = confirmed.stdout.indexOf(
      "Destructive rollback tables: api_keys, device_authorizations",
    );
    const rolledBackIndex = confirmed.stdout.indexOf(
      "Rolled back migration 0005_first_party_api_keys_and_device_auth.",
    );
    expect(inventoryIndex).toBeGreaterThanOrEqual(0);
    expect(rolledBackIndex).toBeGreaterThan(inventoryIndex);
    expect(readTableNames(databasePath)).not.toContain("device_authorizations");
    expect(readColumnNames(databasePath, "api_keys")).toContain("reference_id");
    expect(readColumnNames(databasePath, "api_keys")).not.toContain("permissions_json");
  }, 20_000);

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

function runMigrationCommand(
  command: "down" | "status" | "up",
  databasePath: string,
  // Confirm destructive rollbacks by default so mechanics tests can roll back
  // table-dropping migrations; the gate test overrides this.
  extraEnv: Record<string, string> = { NUSEND_CONFIRM_DESTRUCTIVE_ROLLBACK: "1" },
) {
  return runBun(["src/db/migrate.ts", command], databasePath, extraEnv);
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

function runBun(args: string[], databasePath: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bun", args, {
    cwd: serviceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NUSEND_DB_PATH: databasePath,
      ...extraEnv,
    },
  });
}
