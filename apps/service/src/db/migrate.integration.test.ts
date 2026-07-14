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
    expect(initialStatus).toContain("pending  0009_delivery_ambiguity_and_suppression_safety");

    const migrateUp = runMigrationCommand("up", databasePath).stdout;
    expect(migrateUp).toContain("Applied migration 0001_initial_schema.");
    expect(migrateUp).toContain("Applied migration 0002_simplify_send_queue_and_states.");
    expect(migrateUp).toContain("Applied migration 0003_ses_feedback_ingestion.");
    expect(migrateUp).toContain("Applied migration 0004_ses_operations_and_tracking.");
    expect(migrateUp).toContain("Applied migration 0005_first_party_api_keys_and_device_auth.");
    expect(migrateUp).toContain("Applied migration 0006_device_auth_throttle_cleanup.");
    expect(migrateUp).toContain("Applied migration 0007_mailings_created_id_index.");
    expect(migrateUp).toContain("Applied migration 0008_operations_pagination_and_job_uniqueness.");
    expect(migrateUp).toContain(
      "Applied migration 0009_delivery_ambiguity_and_suppression_safety.",
    );

    const migratedStatus = runMigrationCommand("status", databasePath).stdout;
    expect(migratedStatus).toContain("applied  0001_initial_schema");
    expect(migratedStatus).toContain("applied  0002_simplify_send_queue_and_states");
    expect(migratedStatus).toContain("applied  0003_ses_feedback_ingestion");
    expect(migratedStatus).toContain("applied  0004_ses_operations_and_tracking");
    expect(migratedStatus).toContain("applied  0005_first_party_api_keys_and_device_auth");
    expect(migratedStatus).toContain("applied  0006_device_auth_throttle_cleanup");
    expect(migratedStatus).toContain("applied  0007_mailings_created_id_index");
    expect(migratedStatus).toContain("applied  0008_operations_pagination_and_job_uniqueness");
    expect(migratedStatus).toContain("applied  0009_delivery_ambiguity_and_suppression_safety");

    // 0008 keyset + uniqueness indexes, plus the retained 0002 lookup index.
    expect(readIndexNames(databasePath, "ses_events")).toContain("ses_events_created_id_idx");
    expect(readIndexNames(databasePath, "deliveries")).toContain("deliveries_created_id_idx");
    expect(readIndexNames(databasePath, "jobs")).toEqual(
      expect.arrayContaining(["jobs_delivery_id_idx", "jobs_delivery_id_unique_idx"]),
    );

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
    expect(readTableSql(databasePath, "deliveries")).toContain("'ambiguous'");
    expect(readTableSql(databasePath, "ses_simulator_runs")).toContain("'ambiguous'");

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
      "Rolled back migration 0009_delivery_ambiguity_and_suppression_safety.",
    );
    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0008_operations_pagination_and_job_uniqueness.",
    );
    expect(readIndexNames(databasePath, "jobs")).not.toContain("jobs_delivery_id_unique_idx");
    expect(readIndexNames(databasePath, "jobs")).toContain("jobs_delivery_id_idx");
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
    expect(migrateUpAgain).toContain(
      "Applied migration 0009_delivery_ambiguity_and_suppression_safety.",
    );
    expect(readIndexNames(databasePath, "ses_events")).toContain("ses_events_created_id_idx");
    expect(readIndexNames(databasePath, "deliveries")).toContain("deliveries_created_id_idx");
    expect(readIndexNames(databasePath, "jobs")).toEqual(
      expect.arrayContaining(["jobs_delivery_id_idx", "jobs_delivery_id_unique_idx"]),
    );

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

    // Roll back 0009 and the index-only migrations down to 0005, whose down
    // section drops data-bearing tables (device_authorizations, api_keys).
    expect(runMigrationCommand("down", databasePath).status).toBe(0); // 0009 (lossy graph rebuild)
    expect(runMigrationCommand("down", databasePath).status).toBe(0); // 0008 (indexes)
    expect(runMigrationCommand("down", databasePath).status).toBe(0); // 0007 (index)
    expect(runMigrationCommand("down", databasePath).status).toBe(0); // 0006 (column rebuild)

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

  it("converts only proven historical ambiguity, repairs exact suppressions, and preserves the graph through UP/DOWN/re-UP", () => {
    const databasePath = createTemporaryDatabasePath();
    expect(runMigrationCommand("up", databasePath).status).toBe(0);
    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      "Rolled back migration 0009_delivery_ambiguity_and_suppression_safety.",
    );

    const seeded = runSql(
      databasePath,
      `INSERT INTO mailings (id, purpose, state, subject, html, created_at, updated_at)
       VALUES ('m', 'transactional', 'completed', 'Subject', '<p>Body</p>', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
       INSERT INTO contacts (id, email, created_at, updated_at)
       VALUES ('contact_keep', 'contact@example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
       INSERT INTO deliveries (id, mailing_id, email, contact_id, status, ses_message_id, last_error, created_at, updated_at) VALUES
         ('d_proven', 'm', 'proven@example.com', 'contact_keep', 'failed', NULL, 'unknown', '2026-01-01T00:00:02.001Z', '2026-01-01T00:00:03.001Z'),
         ('d_equal', 'm', 'equal@example.com', NULL, 'failed', 'equal-proof', 'unknown', '2026-01-01T00:00:02.010Z', '2026-01-01T00:00:03.010Z'),
         ('d_delivery_only', 'm', 'delivery-only@example.com', NULL, 'failed', 'delivery-only', 'unknown', '2026-01-01T00:00:02.002Z', '2026-01-01T00:00:03.002Z'),
         ('d_older', 'm', 'older@example.com', NULL, 'failed', NULL, 'unknown', '2026-01-01T00:00:02.003Z', '2026-01-01T00:00:03.003Z'),
         ('d_conflict', 'm', 'conflict@example.com', NULL, 'failed', 'delivery-proof', 'unknown', '2026-01-01T00:00:02.004Z', '2026-01-01T00:00:03.004Z'),
         ('d_unproven', 'm', 'unproven@example.com', NULL, 'failed', NULL, 'unknown', '2026-01-01T00:00:02.005Z', '2026-01-01T00:00:03.005Z'),
         ('d_failed', 'm', 'failed@example.com', NULL, 'failed', NULL, 'permanent', '2026-01-01T00:00:02.006Z', '2026-01-01T00:00:03.006Z'),
         ('d_suppressed', 'm', 'suppressed@example.com', NULL, 'suppressed', NULL, 'policy', '2026-01-01T00:00:02.007Z', '2026-01-01T00:00:03.007Z'),
         ('d_sent', 'm', 'sent@example.com', NULL, 'sent', 'already-sent', NULL, '2026-01-01T00:00:02.008Z', '2026-01-01T00:00:03.008Z');
       INSERT INTO jobs (id, state, run_at, attempts, max_attempts, delivery_id, last_error, created_at, updated_at)
       SELECT 'j_' || id, 'dead', '2026-01-01T00:00:02.000Z', 1, 1, id, 'queue-history', '2026-01-01T00:00:02.100Z', '2026-01-01T00:00:03.100Z'
       FROM deliveries;
       INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message, started_at, finished_at) VALUES
         ('a_proven', 'd_proven', 'j_d_proven', 1, 'ambiguous', 'proof-1', 'unknown', '2026-01-01T00:00:02.201Z', '2026-01-01T00:00:03.201Z'),
         ('a_equal', 'd_equal', 'j_d_equal', 1, 'ambiguous', 'equal-proof', 'unknown', '2026-01-01T00:00:02.210Z', '2026-01-01T00:00:03.210Z'),
         ('a_delivery_only', 'd_delivery_only', 'j_d_delivery_only', 1, 'ambiguous', NULL, 'unknown', '2026-01-01T00:00:02.202Z', '2026-01-01T00:00:03.202Z'),
         ('a_older_1', 'd_older', 'j_d_older', 1, 'ambiguous', 'older-proof', 'unknown', '2026-01-01T00:00:02.203Z', '2026-01-01T00:00:03.203Z'),
         ('a_older_2', 'd_older', 'j_d_older', 2, 'ambiguous', NULL, 'latest-unknown', '2026-01-01T00:00:02.204Z', '2026-01-01T00:00:03.204Z'),
         ('a_conflict', 'd_conflict', 'j_d_conflict', 1, 'ambiguous', 'attempt-proof', 'unknown', '2026-01-01T00:00:02.205Z', '2026-01-01T00:00:03.205Z'),
         ('a_unproven', 'd_unproven', 'j_d_unproven', 1, 'ambiguous', NULL, 'unknown', '2026-01-01T00:00:02.206Z', '2026-01-01T00:00:03.206Z'),
         ('a_failed', 'd_failed', 'j_d_failed', 1, 'failed', NULL, 'permanent', '2026-01-01T00:00:02.207Z', '2026-01-01T00:00:03.207Z'),
         ('a_suppressed', 'd_suppressed', 'j_d_suppressed', 1, 'failed', NULL, 'policy', '2026-01-01T00:00:02.208Z', '2026-01-01T00:00:03.208Z'),
         ('a_sent', 'd_sent', 'j_d_sent', 1, 'succeeded', 'already-sent', NULL, '2026-01-01T00:00:02.209Z', '2026-01-01T00:00:03.209Z');
       INSERT INTO ses_notifications (id, sns_message_id, sns_topic_arn, sns_type, raw_json, received_at)
       VALUES ('n', 'sns-n', 'arn:test', 'Notification', '{}', '2026-01-01T00:00:04.000Z');
       INSERT INTO suppressions (id, email, scope, reason, created_at) VALUES
         ('s_complaint', 'COMPLAINT@example.com', 'all', 'manual', '2025-01-01T00:00:00.001Z'),
         ('s_both', 'both@example.com', 'all', 'manual', '2025-01-01T00:00:00.002Z'),
         ('s_bounce', 'bounce@example.com', 'all', 'manual', '2025-01-01T00:00:00.003Z'),
         ('s_other', 'other@example.com', 'all', 'manual', '2025-01-01T00:00:00.004Z'),
         ('s_transient', 'transient@example.com', 'all', 'manual', '2025-01-01T00:00:00.005Z'),
         ('s_not_spam', 'notspam@example.com', 'all', 'manual', '2025-01-01T00:00:00.006Z'),
         ('s_recorded', 'recorded@example.com', 'all', 'manual', '2025-01-01T00:00:00.007Z'),
         ('s_null', 'null@example.com', 'all', 'manual', '2025-01-01T00:00:00.008Z'),
         ('s_marketing', 'marketing@example.com', 'marketing', 'manual', '2025-01-01T00:00:00.009Z');
       INSERT INTO ses_events (id, dedupe_key, notification_id, event_type, recipient_email, action_taken, bounce_type, created_at) VALUES
         ('e_complaint', 'e1', 'n', 'Complaint', 'complaint@example.com', 'suppressed', NULL, '2026-01-01T00:00:04.001Z'),
         ('e_both_bounce', 'e2', 'n', 'Bounce', 'both@example.com', 'suppressed', 'Permanent', '2026-01-01T00:00:04.002Z'),
         ('e_both_complaint', 'e3', 'n', 'Complaint', 'both@example.com', 'suppressed', NULL, '2026-01-01T00:00:04.003Z'),
         ('e_bounce', 'e4', 'n', 'Bounce', 'BOUNCE@example.com', 'suppressed', 'Permanent', '2026-01-01T00:00:04.004Z'),
         ('e_other', 'e5', 'n', 'Bounce', 'different@example.com', 'suppressed', 'Permanent', '2026-01-01T00:00:04.005Z'),
         ('e_transient', 'e6', 'n', 'Bounce', 'transient@example.com', 'suppressed', 'Transient', '2026-01-01T00:00:04.006Z'),
         ('e_not_spam', 'e7', 'n', 'Complaint', 'notspam@example.com', 'ignored', NULL, '2026-01-01T00:00:04.007Z'),
         ('e_recorded', 'e8', 'n', 'Complaint', 'recorded@example.com', 'recorded', NULL, '2026-01-01T00:00:04.008Z'),
         ('e_null', 'e9', 'n', 'Complaint', NULL, 'suppressed', NULL, '2026-01-01T00:00:04.009Z'),
         ('e_marketing', 'e10', 'n', 'Complaint', 'marketing@example.com', 'suppressed', NULL, '2026-01-01T00:00:04.010Z');
       UPDATE ses_events SET delivery_id = 'd_unproven', mailing_id = 'm' WHERE id = 'e_complaint';
       INSERT INTO ses_simulator_runs (id, scenario, mode, purpose, delivery_id, recipient_email, status, error_message, started_at) VALUES
         ('sim_proven', 'success', 'send_acceptance', 'transactional', 'd_proven', 'proven@example.com', 'failed', 'proven old error', '2026-01-01T00:00:05.001Z'),
         ('sim_unproven', 'success', 'send_acceptance', 'transactional', 'd_unproven', 'unproven@example.com', 'failed', 'unproven old error', '2026-01-01T00:00:05.002Z'),
         ('sim_unrelated', 'success', 'send_acceptance', 'transactional', NULL, 'unrelated@example.com', 'failed', 'unrelated old error', '2026-01-01T00:00:05.003Z'),
         ('sim_existing_sent', 'success', 'send_acceptance', 'transactional', 'd_sent', 'sent@example.com', 'failed', 'existing sent old error', '2026-01-01T00:00:05.004Z');`,
    );
    expect(seeded.status).toBe(0);

    expect(runMigrationCommand("up", databasePath).status).toBe(0);
    expect(readForeignKeyViolations(databasePath)).toEqual([]);
    expectGraphIndexes(databasePath);
    expect(
      readRows(
        databasePath,
        "SELECT id, status, ses_message_id AS messageId, last_error AS error FROM deliveries ORDER BY id;",
      ),
    ).toEqual([
      { error: "unknown", id: "d_conflict", messageId: "delivery-proof", status: "ambiguous" },
      { error: "unknown", id: "d_delivery_only", messageId: "delivery-only", status: "ambiguous" },
      { error: null, id: "d_equal", messageId: "equal-proof", status: "sent" },
      { error: "permanent", id: "d_failed", messageId: null, status: "failed" },
      { error: "unknown", id: "d_older", messageId: null, status: "ambiguous" },
      { error: null, id: "d_proven", messageId: "proof-1", status: "sent" },
      { error: null, id: "d_sent", messageId: "already-sent", status: "sent" },
      { error: "policy", id: "d_suppressed", messageId: null, status: "suppressed" },
      { error: "unknown", id: "d_unproven", messageId: null, status: "ambiguous" },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, status, error_message AS error, started_at AS startedAt, finished_at AS finishedAt FROM send_attempts WHERE id IN ('a_proven', 'a_older_1') ORDER BY id;",
      ),
    ).toEqual([
      {
        error: "unknown",
        finishedAt: "2026-01-01T00:00:03.203Z",
        id: "a_older_1",
        startedAt: "2026-01-01T00:00:02.203Z",
        status: "ambiguous",
      },
      {
        error: null,
        finishedAt: "2026-01-01T00:00:03.201Z",
        id: "a_proven",
        startedAt: "2026-01-01T00:00:02.201Z",
        status: "succeeded",
      },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, status, error_message AS errorMessage FROM ses_simulator_runs ORDER BY id;",
      ),
    ).toEqual([
      { errorMessage: "existing sent old error", id: "sim_existing_sent", status: "failed" },
      { errorMessage: null, id: "sim_proven", status: "sent" },
      { errorMessage: "unproven old error", id: "sim_unproven", status: "ambiguous" },
      { errorMessage: "unrelated old error", id: "sim_unrelated", status: "failed" },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, delivery_id AS deliveryId, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE id = 'j_d_proven';",
      ),
    ).toEqual([
      {
        createdAt: "2026-01-01T00:00:02.100Z",
        deliveryId: "d_proven",
        id: "j_d_proven",
        updatedAt: "2026-01-01T00:00:03.100Z",
      },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, delivery_id AS deliveryId, mailing_id AS mailingId, created_at AS createdAt FROM ses_events WHERE id = 'e_complaint';",
      ),
    ).toEqual([
      {
        createdAt: "2026-01-01T00:00:04.001Z",
        deliveryId: "d_unproven",
        id: "e_complaint",
        mailingId: "m",
      },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, delivery_id AS deliveryId, started_at AS startedAt FROM ses_simulator_runs WHERE id = 'sim_proven';",
      ),
    ).toEqual([
      { deliveryId: "d_proven", id: "sim_proven", startedAt: "2026-01-01T00:00:05.001Z" },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, reason, created_at AS createdAt FROM suppressions ORDER BY id;",
      ),
    ).toEqual([
      { createdAt: "2025-01-01T00:00:00.002Z", id: "s_both", reason: "complaint" },
      { createdAt: "2025-01-01T00:00:00.003Z", id: "s_bounce", reason: "bounce" },
      { createdAt: "2025-01-01T00:00:00.001Z", id: "s_complaint", reason: "complaint" },
      { createdAt: "2025-01-01T00:00:00.009Z", id: "s_marketing", reason: "manual" },
      { createdAt: "2025-01-01T00:00:00.006Z", id: "s_not_spam", reason: "manual" },
      { createdAt: "2025-01-01T00:00:00.008Z", id: "s_null", reason: "manual" },
      { createdAt: "2025-01-01T00:00:00.004Z", id: "s_other", reason: "manual" },
      { createdAt: "2025-01-01T00:00:00.007Z", id: "s_recorded", reason: "manual" },
      { createdAt: "2025-01-01T00:00:00.005Z", id: "s_transient", reason: "manual" },
    ]);
    expect(readIndexNames(databasePath, "deliveries")).toEqual(
      expect.arrayContaining([
        "deliveries_contact_id_idx",
        "deliveries_created_id_idx",
        "deliveries_email_idx",
        "deliveries_mailing_id_idx",
        "deliveries_mailing_status_idx",
        "deliveries_ses_message_id_idx",
      ]),
    );
    expect(readIndexNames(databasePath, "jobs")).toEqual(
      expect.arrayContaining([
        "jobs_delivery_id_idx",
        "jobs_delivery_id_unique_idx",
        "jobs_locked_until_idx",
        "jobs_state_run_at_idx",
      ]),
    );
    expect(readIndexNames(databasePath, "send_attempts")).toEqual(
      expect.arrayContaining([
        "send_attempts_delivery_id_idx",
        "send_attempts_job_id_idx",
        "send_attempts_ses_message_id_idx",
        "send_attempts_status_idx",
      ]),
    );
    expect(readIndexNames(databasePath, "ses_events")).toEqual(
      expect.arrayContaining([
        "ses_events_created_id_idx",
        "ses_events_delivery_id_idx",
        "ses_events_event_created_idx",
        "ses_events_link_url_idx",
        "ses_events_mailing_id_idx",
        "ses_events_recipient_email_idx",
        "ses_events_ses_message_id_idx",
      ]),
    );
    expect(readIndexNames(databasePath, "ses_simulator_runs")).toEqual(
      expect.arrayContaining([
        "ses_simulator_runs_started_at_idx",
        "ses_simulator_runs_status_idx",
      ]),
    );
    expect(
      runSql(
        databasePath,
        "INSERT INTO deliveries (id, mailing_id, email, status) VALUES ('invalid', 'm', 'invalid@example.com', 'invalid');",
      ).status,
    ).not.toBe(0);
    expect(
      runSql(
        databasePath,
        "INSERT INTO ses_simulator_runs (id, scenario, mode, purpose, recipient_email, status, started_at) VALUES ('invalid_sim', 'success', 'send_acceptance', 'transactional', 'invalid@example.com', 'invalid', '2026-01-01T00:00:00.000Z');",
      ).status,
    ).not.toBe(0);
    expect(
      runSql(
        databasePath,
        `INSERT INTO ses_notifications (id, sns_message_id, sns_topic_arn, sns_type, raw_json, received_at) VALUES ('n_delete', 'sns-delete', 'arn:test', 'Notification', '{}', '2026-01-01T00:00:00.000Z');
      INSERT INTO ses_events (id, dedupe_key, notification_id, event_type, action_taken, created_at) VALUES ('e_delete', 'delete', 'n_delete', 'Unknown', 'ignored', '2026-01-01T00:00:00.000Z');
      DELETE FROM ses_notifications WHERE id = 'n_delete';`,
      ).status,
    ).toBe(0);
    expect(
      readRows(databasePath, "SELECT count(*) AS count FROM ses_events WHERE id = 'e_delete';"),
    ).toEqual([{ count: 0 }]);

    expect(runSql(databasePath, "DELETE FROM contacts WHERE id = 'contact_keep';").status).toBe(0);
    expect(
      readRows(
        databasePath,
        "SELECT contact_id AS contactId FROM deliveries WHERE id = 'd_proven';",
      ),
    ).toEqual([{ contactId: null }]);
    expect(runSql(databasePath, "DELETE FROM deliveries WHERE id = 'd_unproven';").status).toBe(0);
    expect(
      readRows(
        databasePath,
        "SELECT count(*) AS count FROM jobs WHERE delivery_id = 'd_unproven';",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      readRows(
        databasePath,
        "SELECT count(*) AS count FROM send_attempts WHERE delivery_id = 'd_unproven';",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      readRows(
        databasePath,
        "SELECT delivery_id AS deliveryId FROM ses_simulator_runs WHERE id = 'sim_unproven';",
      ),
    ).toEqual([{ deliveryId: null }]);
    expect(
      readRows(
        databasePath,
        "SELECT delivery_id AS deliveryId, mailing_id AS mailingId FROM ses_events WHERE id = 'e_complaint';",
      ),
    ).toEqual([{ deliveryId: null, mailingId: "m" }]);

    expect(runMigrationCommand("down", databasePath).status).toBe(0);
    expect(readForeignKeyViolations(databasePath)).toEqual([]);
    expectGraphIndexes(databasePath);
    expect(
      readRows(
        databasePath,
        "SELECT id, status FROM deliveries WHERE id IN ('d_conflict', 'd_older') ORDER BY id;",
      ),
    ).toEqual([
      { id: "d_conflict", status: "failed" },
      { id: "d_older", status: "failed" },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, status, error_message AS errorMessage FROM ses_simulator_runs ORDER BY id;",
      ),
    ).toEqual([
      { errorMessage: "existing sent old error", id: "sim_existing_sent", status: "failed" },
      { errorMessage: null, id: "sim_proven", status: "sent" },
      { errorMessage: "unproven old error", id: "sim_unproven", status: "failed" },
      { errorMessage: "unrelated old error", id: "sim_unrelated", status: "failed" },
    ]);
    expect(readRows(databasePath, "SELECT count(*) AS count FROM jobs;")).toEqual([{ count: 8 }]);
    expect(readRows(databasePath, "SELECT count(*) AS count FROM send_attempts;")).toEqual([
      { count: 9 },
    ]);
    expect(readRows(databasePath, "SELECT count(*) AS count FROM ses_events;")).toEqual([
      { count: 10 },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, delivery_id AS deliveryId, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE id = 'j_d_proven';",
      ),
    ).toEqual([
      {
        createdAt: "2026-01-01T00:00:02.100Z",
        deliveryId: "d_proven",
        id: "j_d_proven",
        updatedAt: "2026-01-01T00:00:03.100Z",
      },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, delivery_id AS deliveryId, mailing_id AS mailingId, created_at AS createdAt FROM ses_events WHERE id = 'e_complaint';",
      ),
    ).toEqual([
      {
        createdAt: "2026-01-01T00:00:04.001Z",
        deliveryId: null,
        id: "e_complaint",
        mailingId: "m",
      },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, delivery_id AS deliveryId, started_at AS startedAt FROM ses_simulator_runs WHERE id = 'sim_proven';",
      ),
    ).toEqual([
      { deliveryId: "d_proven", id: "sim_proven", startedAt: "2026-01-01T00:00:05.001Z" },
    ]);
    expect(
      readRows(databasePath, "SELECT reason FROM suppressions WHERE id = 's_complaint';"),
    ).toEqual([{ reason: "complaint" }]);
    expect(
      runSql(
        databasePath,
        "INSERT INTO deliveries (id, mailing_id, email, status) VALUES ('down_ambiguous', 'm', 'down@example.com', 'ambiguous');",
      ).status,
    ).not.toBe(0);

    expect(runMigrationCommand("up", databasePath).status).toBe(0);
    expect(readForeignKeyViolations(databasePath)).toEqual([]);
    expectGraphIndexes(databasePath);
    expect(
      readRows(
        databasePath,
        "SELECT id, status FROM deliveries WHERE id IN ('d_conflict', 'd_older') ORDER BY id;",
      ),
    ).toEqual([
      { id: "d_conflict", status: "ambiguous" },
      { id: "d_older", status: "ambiguous" },
    ]);
    expect(
      readRows(
        databasePath,
        "SELECT id, status, error_message AS errorMessage FROM ses_simulator_runs ORDER BY id;",
      ),
    ).toEqual([
      { errorMessage: "existing sent old error", id: "sim_existing_sent", status: "failed" },
      { errorMessage: null, id: "sim_proven", status: "sent" },
      { errorMessage: "unproven old error", id: "sim_unproven", status: "failed" },
      { errorMessage: "unrelated old error", id: "sim_unrelated", status: "failed" },
    ]);
    expect(
      readRows(databasePath, "SELECT reason FROM suppressions WHERE id = 's_complaint';"),
    ).toEqual([{ reason: "complaint" }]);
  }, 30_000);

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

function readRows(databasePath: string, sql: string): Array<Record<string, unknown>> {
  const result = runBun(
    [
      "-e",
      "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); const rows = db.query(process.env.NUSEND_TEST_SQL).all(); console.log(JSON.stringify(rows)); db.close();",
    ],
    databasePath,
    { NUSEND_TEST_SQL: sql },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Array<Record<string, unknown>>;
}

function readForeignKeyViolations(databasePath: string): Array<Record<string, unknown>> {
  return readRows(databasePath, "PRAGMA foreign_key_check;");
}

function expectGraphIndexes(databasePath: string): void {
  expect(readIndexNames(databasePath, "deliveries")).toEqual(
    expect.arrayContaining([
      "deliveries_contact_id_idx",
      "deliveries_created_id_idx",
      "deliveries_email_idx",
      "deliveries_mailing_id_idx",
      "deliveries_mailing_status_idx",
      "deliveries_ses_message_id_idx",
    ]),
  );
  expect(readIndexNames(databasePath, "jobs")).toEqual(
    expect.arrayContaining([
      "jobs_delivery_id_idx",
      "jobs_delivery_id_unique_idx",
      "jobs_locked_until_idx",
      "jobs_state_run_at_idx",
    ]),
  );
  expect(readIndexNames(databasePath, "send_attempts")).toEqual(
    expect.arrayContaining([
      "send_attempts_delivery_id_idx",
      "send_attempts_job_id_idx",
      "send_attempts_ses_message_id_idx",
      "send_attempts_status_idx",
    ]),
  );
  expect(readIndexNames(databasePath, "ses_events")).toEqual(
    expect.arrayContaining([
      "ses_events_created_id_idx",
      "ses_events_delivery_id_idx",
      "ses_events_event_created_idx",
      "ses_events_link_url_idx",
      "ses_events_mailing_id_idx",
      "ses_events_recipient_email_idx",
      "ses_events_ses_message_id_idx",
    ]),
  );
  expect(readIndexNames(databasePath, "ses_simulator_runs")).toEqual(
    expect.arrayContaining(["ses_simulator_runs_started_at_idx", "ses_simulator_runs_status_idx"]),
  );
}

function runSql(databasePath: string, sql: string) {
  return runBun(
    [
      "-e",
      "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); db.run('PRAGMA foreign_keys = ON;'); db.exec(process.env.NUSEND_TEST_SQL); db.close();",
    ],
    databasePath,
    { NUSEND_TEST_SQL: sql },
  );
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
