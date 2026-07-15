import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectories: string[] = [];

const applicationTables = [
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
  "send_attempts",
  "ses_events",
  "ses_notifications",
  "ses_simulator_runs",
  "sessions",
  "suppressions",
  "users",
  "verifications",
  "worker_runs",
] as const;

const binary = (column: string) => ({
  collation: "BINARY",
  column,
  direction: "ASC",
  expression: null,
});
const nocase = (column: string) => ({
  collation: "NOCASE",
  column,
  direction: "ASC",
  expression: null,
});
const descending = (column: string) => ({
  collation: "BINARY",
  column,
  direction: "DESC",
  expression: null,
});

const expectedIndexes = {
  accounts_user_id_idx: index("accounts", false, [binary("user_id")]),
  api_keys_last_used_at_idx: index("api_keys", false, [binary("last_used_at")]),
  api_keys_revoked_at_idx: index("api_keys", false, [binary("revoked_at")]),
  api_keys_user_id_idx: index("api_keys", false, [binary("user_id")]),
  contacts_email_idx: index("contacts", true, [nocase("email")]),
  deliveries_contact_id_idx: index("deliveries", false, [binary("contact_id")]),
  deliveries_created_id_idx: index("deliveries", false, [
    descending("created_at"),
    descending("id"),
  ]),
  deliveries_email_idx: index("deliveries", false, [nocase("email")]),
  deliveries_mailing_id_idx: index("deliveries", false, [binary("mailing_id")]),
  deliveries_mailing_status_idx: index("deliveries", false, [
    binary("mailing_id"),
    binary("status"),
  ]),
  deliveries_ses_message_id_idx: index(
    "deliveries",
    true,
    [binary("ses_message_id")],
    "ses_message_id IS NOT NULL",
  ),
  device_authorizations_approved_user_idx: index("device_authorizations", false, [
    binary("approved_by_user_id"),
  ]),
  device_authorizations_expires_at_idx: index("device_authorizations", false, [
    binary("expires_at"),
  ]),
  jobs_delivery_id_idx: index("jobs", false, [binary("delivery_id")]),
  jobs_delivery_id_unique_idx: index("jobs", true, [binary("delivery_id")]),
  jobs_locked_until_idx: index("jobs", false, [binary("locked_until")]),
  jobs_state_run_at_idx: index("jobs", false, [binary("state"), binary("run_at")]),
  list_memberships_contact_id_idx: index("list_memberships", false, [binary("contact_id")]),
  list_memberships_subscribed_idx: index("list_memberships", false, [
    binary("list_id"),
    binary("unsubscribed_at"),
  ]),
  lists_name_idx: index("lists", false, [binary("name")]),
  mailing_idempotency_keys_mailing_id_idx: index("mailing_idempotency_keys", false, [
    binary("mailing_id"),
  ]),
  mailings_created_id_idx: index("mailings", false, [descending("created_at"), descending("id")]),
  mailings_list_id_idx: index("mailings", false, [binary("list_id")]),
  mailings_purpose_state_idx: index("mailings", false, [binary("purpose"), binary("state")]),
  mailings_scheduled_at_idx: index("mailings", false, [binary("scheduled_at")]),
  send_attempts_delivery_id_idx: index("send_attempts", false, [binary("delivery_id")]),
  send_attempts_job_id_idx: index("send_attempts", false, [binary("job_id")]),
  send_attempts_ses_message_id_idx: index(
    "send_attempts",
    false,
    [binary("ses_message_id")],
    "ses_message_id IS NOT NULL",
  ),
  send_attempts_status_idx: index("send_attempts", false, [binary("status")]),
  ses_events_created_id_idx: index("ses_events", false, [
    descending("created_at"),
    descending("id"),
  ]),
  ses_events_delivery_id_idx: index("ses_events", false, [binary("delivery_id")]),
  ses_events_event_created_idx: index("ses_events", false, [
    binary("event_type"),
    binary("created_at"),
  ]),
  ses_events_link_url_idx: index("ses_events", false, [binary("link_url")]),
  ses_events_mailing_id_idx: index("ses_events", false, [binary("mailing_id")]),
  ses_events_recipient_email_idx: index("ses_events", false, [nocase("recipient_email")]),
  ses_events_ses_message_id_idx: index("ses_events", false, [binary("ses_message_id")]),
  ses_notifications_received_at_idx: index("ses_notifications", false, [binary("received_at")]),
  ses_simulator_runs_started_at_idx: index("ses_simulator_runs", false, [binary("started_at")]),
  ses_simulator_runs_status_idx: index("ses_simulator_runs", false, [binary("status")]),
  sessions_user_id_idx: index("sessions", false, [binary("user_id")]),
  suppressions_email_global_scope_idx: index(
    "suppressions",
    true,
    [nocase("email"), binary("scope")],
    "list_id IS NULL",
  ),
  suppressions_email_idx: index("suppressions", false, [nocase("email")]),
  suppressions_email_list_idx: index(
    "suppressions",
    true,
    [nocase("email"), binary("list_id")],
    "scope = 'list'",
  ),
  verifications_identifier_idx: index("verifications", false, [binary("identifier")]),
  worker_runs_finished_at_idx: index("worker_runs", false, [binary("finished_at")]),
};

const expectedForeignKeys = [
  foreignKey("accounts", "user_id", "users", "id", "CASCADE"),
  foreignKey("api_keys", "rotated_from_id", "api_keys", "id", "SET NULL"),
  foreignKey("api_keys", "user_id", "users", "id", "CASCADE"),
  foreignKey("deliveries", "contact_id", "contacts", "id", "SET NULL"),
  foreignKey("deliveries", "mailing_id", "mailings", "id", "CASCADE"),
  foreignKey("device_authorizations", "approved_by_user_id", "users", "id", "CASCADE"),
  foreignKey("jobs", "delivery_id", "deliveries", "id", "CASCADE"),
  foreignKey("list_memberships", "contact_id", "contacts", "id", "CASCADE"),
  foreignKey("list_memberships", "list_id", "lists", "id", "CASCADE"),
  foreignKey("mailing_idempotency_keys", "mailing_id", "mailings", "id", "CASCADE"),
  foreignKey("mailings", "list_id", "lists", "id", "SET NULL"),
  foreignKey("send_attempts", "delivery_id", "deliveries", "id", "CASCADE"),
  foreignKey("send_attempts", "job_id", "jobs", "id", "CASCADE"),
  foreignKey("ses_events", "delivery_id", "deliveries", "id", "SET NULL"),
  foreignKey("ses_events", "mailing_id", "mailings", "id", "SET NULL"),
  foreignKey("ses_events", "notification_id", "ses_notifications", "id", "CASCADE"),
  foreignKey("ses_simulator_runs", "delivery_id", "deliveries", "id", "SET NULL"),
  foreignKey("ses_simulator_runs", "mailing_id", "mailings", "id", "SET NULL"),
  foreignKey("sessions", "user_id", "users", "id", "CASCADE"),
  foreignKey("suppressions", "list_id", "lists", "id", "CASCADE"),
];

function expectedColumn(
  name: string,
  declaredType: string,
  notNull: number,
  defaultValue: string | null,
  primaryKeyPosition: number,
) {
  return { declaredType, defaultValue, name, notNull, primaryKeyPosition };
}

const expectedColumns = {
  accounts: [
    expectedColumn("id", "TEXT", 1, null, 1),
    expectedColumn("account_id", "TEXT", 1, null, 0),
    expectedColumn("provider_id", "TEXT", 1, null, 0),
    expectedColumn("user_id", "TEXT", 1, null, 0),
    expectedColumn("access_token", "TEXT", 0, null, 0),
    expectedColumn("refresh_token", "TEXT", 0, null, 0),
    expectedColumn("id_token", "TEXT", 0, null, 0),
    expectedColumn("access_token_expires_at", "DATE", 0, null, 0),
    expectedColumn("refresh_token_expires_at", "DATE", 0, null, 0),
    expectedColumn("scope", "TEXT", 0, null, 0),
    expectedColumn("password", "TEXT", 0, null, 0),
    expectedColumn("created_at", "DATE", 1, null, 0),
    expectedColumn("updated_at", "DATE", 1, null, 0),
  ],
  api_keys: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("user_id", "TEXT", 1, null, 0),
    expectedColumn("name", "TEXT", 1, null, 0),
    expectedColumn("prefix", "TEXT", 1, null, 0),
    expectedColumn("key_hash", "TEXT", 1, null, 0),
    expectedColumn("key_preview", "TEXT", 1, null, 0),
    expectedColumn("permissions_json", "TEXT", 1, null, 0),
    expectedColumn("created_at", "TEXT", 1, null, 0),
    expectedColumn("last_used_at", "TEXT", 0, null, 0),
    expectedColumn("expires_at", "TEXT", 0, null, 0),
    expectedColumn("revoked_at", "TEXT", 0, null, 0),
    expectedColumn("rotated_from_id", "TEXT", 0, null, 0),
  ],
  contacts: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("email", "TEXT", 1, null, 0),
    expectedColumn("created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
    expectedColumn("updated_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
  ],
  deliveries: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("mailing_id", "TEXT", 1, null, 0),
    expectedColumn("email", "TEXT", 1, null, 0),
    expectedColumn("contact_id", "TEXT", 0, null, 0),
    expectedColumn("vars_json", "TEXT", 0, null, 0),
    expectedColumn("status", "TEXT", 1, null, 0),
    expectedColumn("ses_message_id", "TEXT", 0, null, 0),
    expectedColumn("last_error", "TEXT", 0, null, 0),
    expectedColumn("created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
    expectedColumn("updated_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
  ],
  device_authorizations: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("device_code_hash", "TEXT", 1, null, 0),
    expectedColumn("user_code_hash", "TEXT", 1, null, 0),
    expectedColumn("user_code_preview", "TEXT", 1, null, 0),
    expectedColumn("requested_permissions_json", "TEXT", 1, null, 0),
    expectedColumn("client_name", "TEXT", 1, null, 0),
    expectedColumn("approved_by_user_id", "TEXT", 0, null, 0),
    expectedColumn("approved_at", "TEXT", 0, null, 0),
    expectedColumn("denied_at", "TEXT", 0, null, 0),
    expectedColumn("consumed_at", "TEXT", 0, null, 0),
    expectedColumn("expires_at", "TEXT", 1, null, 0),
    expectedColumn("poll_count", "INTEGER", 1, "0", 0),
    expectedColumn("last_poll_at", "TEXT", 0, null, 0),
    expectedColumn("requester_fingerprint_hash", "TEXT", 0, null, 0),
    expectedColumn("created_at", "TEXT", 1, null, 0),
  ],
  jobs: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("state", "TEXT", 1, null, 0),
    expectedColumn("run_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
    expectedColumn("attempts", "INTEGER", 1, "0", 0),
    expectedColumn("max_attempts", "INTEGER", 1, "10", 0),
    expectedColumn("locked_by", "TEXT", 0, null, 0),
    expectedColumn("locked_until", "TEXT", 0, null, 0),
    expectedColumn("delivery_id", "TEXT", 1, null, 0),
    expectedColumn("last_error", "TEXT", 0, null, 0),
    expectedColumn("created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
    expectedColumn("updated_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
  ],
  list_memberships: [
    expectedColumn("list_id", "TEXT", 1, null, 1),
    expectedColumn("contact_id", "TEXT", 1, null, 2),
    expectedColumn("subscribed_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
    expectedColumn("unsubscribed_at", "TEXT", 0, null, 0),
  ],
  lists: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("name", "TEXT", 1, null, 0),
    expectedColumn("created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
  ],
  mailing_idempotency_keys: [
    expectedColumn("key", "TEXT", 0, null, 1),
    expectedColumn("request_hash", "TEXT", 1, null, 0),
    expectedColumn("mailing_id", "TEXT", 1, null, 0),
    expectedColumn("response_json", "TEXT", 1, null, 0),
    expectedColumn("created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
  ],
  mailings: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("purpose", "TEXT", 1, null, 0),
    expectedColumn("state", "TEXT", 1, null, 0),
    expectedColumn("name", "TEXT", 0, null, 0),
    expectedColumn("subject", "TEXT", 1, null, 0),
    expectedColumn("html", "TEXT", 1, null, 0),
    expectedColumn("text", "TEXT", 0, null, 0),
    expectedColumn("list_id", "TEXT", 0, null, 0),
    expectedColumn("scheduled_at", "TEXT", 0, null, 0),
    expectedColumn("created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
    expectedColumn("updated_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
  ],
  send_attempts: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("delivery_id", "TEXT", 1, null, 0),
    expectedColumn("job_id", "TEXT", 1, null, 0),
    expectedColumn("attempt_no", "INTEGER", 1, null, 0),
    expectedColumn("status", "TEXT", 1, null, 0),
    expectedColumn("ses_message_id", "TEXT", 0, null, 0),
    expectedColumn("error_message", "TEXT", 0, null, 0),
    expectedColumn("started_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
    expectedColumn("finished_at", "TEXT", 0, null, 0),
  ],
  ses_events: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("dedupe_key", "TEXT", 1, null, 0),
    expectedColumn("notification_id", "TEXT", 1, null, 0),
    expectedColumn("event_type", "TEXT", 1, null, 0),
    expectedColumn("delivery_id", "TEXT", 0, null, 0),
    expectedColumn("mailing_id", "TEXT", 0, null, 0),
    expectedColumn("ses_message_id", "TEXT", 0, null, 0),
    expectedColumn("recipient_email", "TEXT", 0, null, 0),
    expectedColumn("action_taken", "TEXT", 1, null, 0),
    expectedColumn("occurred_at", "TEXT", 0, null, 0),
    expectedColumn("bounce_type", "TEXT", 0, null, 0),
    expectedColumn("bounce_sub_type", "TEXT", 0, null, 0),
    expectedColumn("complaint_feedback_type", "TEXT", 0, null, 0),
    expectedColumn("feedback_id", "TEXT", 0, null, 0),
    expectedColumn("diagnostic_code", "TEXT", 0, null, 0),
    expectedColumn("reject_reason", "TEXT", 0, null, 0),
    expectedColumn("delivery_delay_type", "TEXT", 0, null, 0),
    expectedColumn("link_url", "TEXT", 0, null, 0),
    expectedColumn("link_tags_json", "TEXT", 0, null, 0),
    expectedColumn("ip_address", "TEXT", 0, null, 0),
    expectedColumn("user_agent", "TEXT", 0, null, 0),
    expectedColumn("created_at", "TEXT", 1, null, 0),
  ],
  ses_notifications: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("sns_message_id", "TEXT", 1, null, 0),
    expectedColumn("sns_topic_arn", "TEXT", 1, null, 0),
    expectedColumn("sns_type", "TEXT", 1, null, 0),
    expectedColumn("ses_message_id", "TEXT", 0, null, 0),
    expectedColumn("event_type", "TEXT", 0, null, 0),
    expectedColumn("raw_json", "TEXT", 1, null, 0),
    expectedColumn("received_at", "TEXT", 1, null, 0),
  ],
  ses_simulator_runs: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("scenario", "TEXT", 1, null, 0),
    expectedColumn("mode", "TEXT", 1, null, 0),
    expectedColumn("purpose", "TEXT", 1, null, 0),
    expectedColumn("mailing_id", "TEXT", 0, null, 0),
    expectedColumn("delivery_id", "TEXT", 0, null, 0),
    expectedColumn("recipient_email", "TEXT", 1, null, 0),
    expectedColumn("target_base_url", "TEXT", 0, null, 0),
    expectedColumn("status", "TEXT", 1, null, 0),
    expectedColumn("expected_event_type", "TEXT", 0, null, 0),
    expectedColumn("expected_suppression_reason", "TEXT", 0, null, 0),
    expectedColumn("error_message", "TEXT", 0, null, 0),
    expectedColumn("started_at", "TEXT", 1, null, 0),
    expectedColumn("finished_at", "TEXT", 0, null, 0),
  ],
  sessions: [
    expectedColumn("id", "TEXT", 1, null, 1),
    expectedColumn("expires_at", "DATE", 1, null, 0),
    expectedColumn("token", "TEXT", 1, null, 0),
    expectedColumn("created_at", "DATE", 1, null, 0),
    expectedColumn("updated_at", "DATE", 1, null, 0),
    expectedColumn("ip_address", "TEXT", 0, null, 0),
    expectedColumn("user_agent", "TEXT", 0, null, 0),
    expectedColumn("user_id", "TEXT", 1, null, 0),
  ],
  suppressions: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("email", "TEXT", 1, null, 0),
    expectedColumn("scope", "TEXT", 1, null, 0),
    expectedColumn("list_id", "TEXT", 0, null, 0),
    expectedColumn("reason", "TEXT", 1, null, 0),
    expectedColumn("created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0),
  ],
  users: [
    expectedColumn("id", "TEXT", 1, null, 1),
    expectedColumn("name", "TEXT", 1, null, 0),
    expectedColumn("email", "TEXT", 1, null, 0),
    expectedColumn("email_verified", "INTEGER", 1, null, 0),
    expectedColumn("image", "TEXT", 0, null, 0),
    expectedColumn("created_at", "DATE", 1, null, 0),
    expectedColumn("updated_at", "DATE", 1, null, 0),
  ],
  verifications: [
    expectedColumn("id", "TEXT", 1, null, 1),
    expectedColumn("identifier", "TEXT", 1, null, 0),
    expectedColumn("value", "TEXT", 1, null, 0),
    expectedColumn("expires_at", "DATE", 1, null, 0),
    expectedColumn("created_at", "DATE", 1, null, 0),
    expectedColumn("updated_at", "DATE", 1, null, 0),
  ],
  worker_runs: [
    expectedColumn("id", "TEXT", 0, null, 1),
    expectedColumn("worker_id", "TEXT", 1, null, 0),
    expectedColumn("mode", "TEXT", 1, null, 0),
    expectedColumn("released", "INTEGER", 1, null, 0),
    expectedColumn("claimed", "INTEGER", 1, null, 0),
    expectedColumn("succeeded", "INTEGER", 1, null, 0),
    expectedColumn("failed", "INTEGER", 1, null, 0),
    expectedColumn("dead", "INTEGER", 1, null, 0),
    expectedColumn("skipped_stale", "INTEGER", 1, null, 0),
    expectedColumn("started_at", "TEXT", 1, null, 0),
    expectedColumn("finished_at", "TEXT", 1, null, 0),
  ],
};

const expectedTableSqlSemantics = {
  accounts: [],
  api_keys: [],
  contacts: ["email TEXT NOT NULL COLLATE NOCASE"],
  deliveries: [
    "email TEXT NOT NULL COLLATE NOCASE",
    "CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed', 'ambiguous'))",
  ],
  device_authorizations: [],
  jobs: [
    "CHECK (state IN ('queued', 'leased', 'succeeded', 'dead'))",
    "CHECK (attempts >= 0)",
    "CHECK (max_attempts > 0)",
  ],
  list_memberships: [],
  lists: [],
  mailing_idempotency_keys: [],
  mailings: [
    "CHECK (purpose IN ('transactional', 'marketing'))",
    "CHECK (state IN ('scheduled', 'sending', 'completed'))",
  ],
  send_attempts: [
    "CHECK (attempt_no > 0)",
    "CHECK (status IN ('started', 'succeeded', 'failed', 'ambiguous'))",
  ],
  ses_events: [
    "CHECK (event_type IN ('Send', 'Rendering Failure', 'Reject', 'Delivery', 'DeliveryDelay', 'Bounce', 'Complaint', 'Subscription', 'Open', 'Click', 'Unknown'))",
    "recipient_email TEXT COLLATE NOCASE",
    "CHECK (action_taken IN ('recorded', 'suppressed', 'ignored'))",
  ],
  ses_notifications: [
    "CHECK (sns_type IN ('Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'))",
  ],
  ses_simulator_runs: [
    "CHECK (scenario IN ('success', 'bounce', 'complaint', 'ooto', 'suppressionlist'))",
    "CHECK (mode IN ('send_acceptance', 'end_to_end'))",
    "CHECK (purpose IN ('transactional', 'marketing'))",
    "CHECK (status IN ('started', 'sent', 'validated', 'failed', 'timed_out', 'ambiguous'))",
  ],
  sessions: [],
  suppressions: [
    "email TEXT NOT NULL COLLATE NOCASE",
    "CHECK (scope IN ('all', 'marketing', 'list'))",
    "CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'manual'))",
    "CHECK ((scope = 'list' AND list_id IS NOT NULL) OR (scope IN ('all', 'marketing') AND list_id IS NULL))",
  ],
  users: ["email TEXT NOT NULL UNIQUE COLLATE NOCASE"],
  verifications: [],
  worker_runs: ["CHECK (mode IN ('once', 'loop'))"],
} satisfies Record<(typeof applicationTables)[number], string[]>;

const migrationMarker = "0001_initial_schema";

function index(
  owner: string,
  unique: boolean,
  keys: Array<{
    collation: string;
    column: string;
    direction: string;
    expression: null;
  }>,
  predicate: string | null = null,
) {
  return { keys, owner, predicate, unique };
}

function foreignKey(
  childTable: string,
  childColumn: string,
  parentTable: string,
  parentColumn: string,
  onDelete: string,
) {
  return {
    childColumn,
    childTable,
    match: "NONE",
    onDelete,
    onUpdate: "NO ACTION",
    parentColumn,
    parentTable,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("migration runner", () => {
  it("applies, reports, rolls back, and rejects checksum drift", () => {
    const databasePath = createTemporaryDatabasePath();

    expect(statusLines(databasePath)).toEqual([`pending  ${migrationMarker}`]);
    expect(runMigrationCommand("up", databasePath).stdout.trim()).toBe(
      `Applied migration ${migrationMarker}.`,
    );
    expect(statusLines(databasePath)).toEqual([`applied  ${migrationMarker}`]);

    const initialSchema = readSchemaContract(databasePath);
    expect(initialSchema.tables).toEqual(applicationTables);
    expect(initialSchema.indexes).toEqual(expectedIndexes);
    expect(initialSchema.foreignKeys).toEqual(expectedForeignKeys);
    expect(initialSchema.foreignKeyCheck).toEqual([]);
    expect(initialSchema.columns).toEqual(expectedColumns);
    expect(Object.keys(initialSchema.tableSql)).toEqual(applicationTables);
    for (const table of applicationTables) {
      const normalizedSql = initialSchema.tableSql[table];
      const semantics = expectedTableSqlSemantics[table];
      for (const fragment of semantics) {
        expect(normalizedSql).toContain(normalizeSql(fragment));
      }
      expect(normalizedSql.match(/\bCHECK\s*\(/g) ?? []).toHaveLength(
        semantics.filter((fragment) => fragment.includes("CHECK (")).length,
      );
      expect(normalizedSql.match(/\bCOLLATE\s+/g) ?? []).toHaveLength(
        semantics.filter((fragment) => fragment.includes("COLLATE ")).length,
      );
    }
    expect(Object.keys(initialSchema.indexes)).toHaveLength(45);
    expect(initialSchema.tables).not.toEqual(
      expect.arrayContaining(["ses_feedback_notifications", "ses_feedback_recipients"]),
    );

    expect(
      runSql(
        databasePath,
        `INSERT INTO contacts (id, email) VALUES ('case-1', 'Case@Example.com');
         INSERT INTO contacts (id, email) VALUES ('case-2', 'case@example.com');`,
      ).status,
    ).not.toBe(0);

    expect(
      runSql(
        databasePath,
        "UPDATE schema_migrations SET checksum = 'changed' WHERE version = '0001_initial_schema';",
      ).status,
    ).toBe(0);
    const driftUp = runMigrationCommand("up", databasePath);
    expect(driftUp.status).not.toBe(0);
    expect(driftUp.stderr).toContain("checksum changed");
    const driftDown = runMigrationCommand("down", databasePath);
    expect(driftDown.status).not.toBe(0);
    expect(driftDown.stderr).toContain("migration checksum changed after it was applied");
    restoreMigrationChecksum(databasePath);

    expect(runMigrationCommand("down", databasePath).stdout).toContain(
      `Rolled back migration ${migrationMarker}.`,
    );
    expect(readTableNames(databasePath)).toEqual(["schema_migrations"]);
    expect(runMigrationCommand("down", databasePath).stdout.trim()).toBe(
      "No applied migrations to roll back.",
    );

    expect(runMigrationCommand("up", databasePath).stdout).toContain(
      `Applied migration ${migrationMarker}.`,
    );
    expect(readSchemaContract(databasePath)).toEqual(initialSchema);

    expect(
      runSql(
        databasePath,
        "INSERT INTO schema_migrations (version, checksum) VALUES ('9999_missing', 'no-such-file');",
      ).status,
    ).toBe(0);
    expect(statusLines(databasePath)).toEqual([
      `applied  ${migrationMarker}`,
      "missing  9999_missing",
    ]);
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
    expect(runSql(databasePath, representativeRowsSql).status).toBe(0);
    const schemaBeforeRefusal = readSchemaContract(databasePath);
    const dataBeforeRefusal = readApplicationRows(databasePath);

    const refused = runMigrationCommand("down", databasePath, {
      NUSEND_CONFIRM_DESTRUCTIVE_ROLLBACK: "",
    });
    const inventory = `Destructive rollback tables: ${applicationTables.join(", ")}`;
    expect(refused.status).not.toBe(0);
    expect(refused.stdout.trim()).toBe(inventory);
    expect(refused.stderr).toContain("drops data-bearing table(s)");
    expect(readSchemaContract(databasePath)).toEqual(schemaBeforeRefusal);
    expect(readApplicationRows(databasePath)).toEqual(dataBeforeRefusal);

    const confirmed = runMigrationCommand("down", databasePath);
    expect(confirmed.status).toBe(0);
    expect(confirmed.stdout.trim()).toBe(`${inventory}\nRolled back migration ${migrationMarker}.`);
    expect(readTableNames(databasePath)).toEqual(["schema_migrations"]);
  }, 20_000);

  it("enforces the fresh schema checks, uniqueness, cascades, and SET NULL edges", () => {
    const databasePath = createTemporaryDatabasePath();
    expect(runMigrationCommand("up", databasePath).status).toBe(0);
    expect(readForeignKeyViolations(databasePath)).toEqual([]);

    expect(runSql(databasePath, representativeRowsSql).status).toBe(0);
    for (const invalidSql of [
      "INSERT INTO mailings (id, purpose, state, subject, html) VALUES ('bad-mailing', 'transactional', 'draft', 's', 'h');",
      "INSERT INTO deliveries (id, mailing_id, email, status) VALUES ('bad-delivery', 'm', 'bad@example.com', 'unknown');",
      "INSERT INTO jobs (id, state, delivery_id) VALUES ('bad-job', 'failed', 'd');",
      "INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status) VALUES ('bad-attempt', 'd', 'j', 0, 'started');",
      "INSERT INTO ses_simulator_runs (id, scenario, mode, purpose, recipient_email, status, started_at) VALUES ('bad-sim', 'success', 'send_acceptance', 'transactional', 'bad@example.com', 'unknown', 't');",
      "INSERT INTO suppressions (id, email, scope, reason) VALUES ('bad-suppression', 'bad@example.com', 'list', 'manual');",
    ]) {
      expect(runSql(databasePath, invalidSql).status).not.toBe(0);
    }
    expect(
      runSql(
        databasePath,
        "INSERT INTO jobs (id, state, delivery_id) VALUES ('j2', 'queued', 'd');",
      ).status,
    ).not.toBe(0);

    expect(
      runSql(databasePath, "DELETE FROM ses_notifications WHERE id = 'n-cascade';").status,
    ).toBe(0);
    expect(readRows(databasePath, "SELECT id FROM ses_events WHERE id = 'e-cascade';")).toEqual([]);

    expect(runSql(databasePath, "DELETE FROM contacts WHERE id = 'c';").status).toBe(0);
    expect(readRows(databasePath, "SELECT contact_id AS contactId FROM deliveries;")).toEqual([
      { contactId: null },
    ]);

    expect(runSql(databasePath, "DELETE FROM deliveries WHERE id = 'd';").status).toBe(0);
    expect(readRows(databasePath, "SELECT id FROM jobs;")).toEqual([]);
    expect(readRows(databasePath, "SELECT id FROM send_attempts;")).toEqual([]);
    expect(
      readRows(
        databasePath,
        "SELECT delivery_id AS deliveryId FROM ses_events WHERE id = 'e-refs';",
      ),
    ).toEqual([{ deliveryId: null }]);
    expect(
      readRows(
        databasePath,
        "SELECT delivery_id AS deliveryId FROM ses_simulator_runs WHERE id = 'sim';",
      ),
    ).toEqual([{ deliveryId: null }]);

    expect(runSql(databasePath, "DELETE FROM mailings WHERE id = 'm';").status).toBe(0);
    expect(
      readRows(databasePath, "SELECT mailing_id AS mailingId FROM ses_events WHERE id = 'e-refs';"),
    ).toEqual([{ mailingId: null }]);
    expect(
      readRows(
        databasePath,
        "SELECT mailing_id AS mailingId FROM ses_simulator_runs WHERE id = 'sim';",
      ),
    ).toEqual([{ mailingId: null }]);

    expect(runSql(databasePath, "DELETE FROM api_keys WHERE id = 'key-old';").status).toBe(0);
    expect(
      readRows(databasePath, "SELECT rotated_from_id AS rotatedFromId FROM api_keys;"),
    ).toEqual([{ rotatedFromId: null }]);
    expect(runSql(databasePath, "DELETE FROM users WHERE id = 'u';").status).toBe(0);
    for (const table of ["sessions", "accounts", "api_keys", "device_authorizations"]) {
      expect(readRows(databasePath, `SELECT id FROM ${table};`)).toEqual([]);
    }
    expect(readForeignKeyViolations(databasePath)).toEqual([]);

    expect(runMigrationCommand("down", databasePath).status).toBe(0);
    expect(readTableNames(databasePath)).toEqual(["schema_migrations"]);
    expect(readForeignKeyViolations(databasePath)).toEqual([]);
    expect(runMigrationCommand("up", databasePath).status).toBe(0);
    expect(readForeignKeyViolations(databasePath)).toEqual([]);
  }, 20_000);
});

const representativeRowsSql = `
INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
VALUES ('u', 'User', 'user@example.com', 1, 't', 't');
INSERT INTO sessions (id, expires_at, token, created_at, updated_at, user_id)
VALUES ('session', 't', 'token', 't', 't', 'u');
INSERT INTO accounts (id, account_id, provider_id, user_id, created_at, updated_at)
VALUES ('account', 'provider-account', 'provider', 'u', 't', 't');
INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at)
VALUES ('verification', 'user@example.com', 'value', 't', 't', 't');
INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_preview, permissions_json, created_at)
VALUES ('key-old', 'u', 'old', 'nu', 'hash-old', 'nu_old', '[]', 't');
INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_preview, permissions_json, created_at, rotated_from_id)
VALUES ('key-new', 'u', 'new', 'nu', 'hash-new', 'nu_new', '[]', 't', 'key-old');
INSERT INTO device_authorizations (
  id, device_code_hash, user_code_hash, user_code_preview, requested_permissions_json,
  client_name, approved_by_user_id, expires_at, created_at
) VALUES ('device', 'device-hash', 'user-code-hash', 'ABCD', '[]', 'cli', 'u', 't', 't');
INSERT INTO lists (id, name) VALUES ('l', 'List');
INSERT INTO contacts (id, email) VALUES ('c', 'contact@example.com');
INSERT INTO list_memberships (list_id, contact_id) VALUES ('l', 'c');
INSERT INTO mailings (id, purpose, state, subject, html, list_id)
VALUES ('m', 'transactional', 'scheduled', 'Subject', '<p>Body</p>', 'l');
INSERT INTO deliveries (id, mailing_id, email, contact_id, status)
VALUES ('d', 'm', 'contact@example.com', 'c', 'queued');
INSERT INTO suppressions (id, email, scope, list_id, reason)
VALUES ('suppression', 'other@example.com', 'list', 'l', 'manual');
INSERT INTO jobs (id, state, delivery_id) VALUES ('j', 'queued', 'd');
INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status)
VALUES ('attempt', 'd', 'j', 1, 'started');
INSERT INTO mailing_idempotency_keys (key, request_hash, mailing_id, response_json)
VALUES ('idem', 'request-hash', 'm', '{}');
INSERT INTO ses_notifications (
  id, sns_message_id, sns_topic_arn, sns_type, raw_json, received_at
) VALUES ('n-cascade', 'sns-cascade', 'arn:test', 'Notification', '{}', 't');
INSERT INTO ses_events (
  id, dedupe_key, notification_id, event_type, action_taken, created_at
) VALUES ('e-cascade', 'dedupe-cascade', 'n-cascade', 'Unknown', 'ignored', 't');
INSERT INTO ses_notifications (
  id, sns_message_id, sns_topic_arn, sns_type, raw_json, received_at
) VALUES ('n-refs', 'sns-refs', 'arn:test', 'Notification', '{}', 't');
INSERT INTO ses_events (
  id, dedupe_key, notification_id, event_type, delivery_id, mailing_id,
  recipient_email, action_taken, created_at
) VALUES (
  'e-refs', 'dedupe-refs', 'n-refs', 'Delivery', 'd', 'm',
  'contact@example.com', 'recorded', 't'
);
INSERT INTO ses_simulator_runs (
  id, scenario, mode, purpose, mailing_id, delivery_id, recipient_email, status, started_at
) VALUES (
  'sim', 'success', 'end_to_end', 'transactional', 'm', 'd',
  'contact@example.com', 'validated', 't'
);
INSERT INTO worker_runs (
  id, worker_id, mode, released, claimed, succeeded, failed, dead, skipped_stale,
  started_at, finished_at
) VALUES ('run', 'worker', 'once', 0, 1, 1, 0, 0, 0, 't', 't');
`;

function createTemporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nusend-migrate-"));
  temporaryDirectories.push(directory);
  return join(directory, "nusend.sqlite");
}

function runMigrationCommand(
  command: "down" | "status" | "up",
  databasePath: string,
  extraEnv: Record<string, string> = { NUSEND_CONFIRM_DESTRUCTIVE_ROLLBACK: "1" },
) {
  return runBun(["src/db/migrate.ts", command], databasePath, extraEnv);
}

function statusLines(databasePath: string): string[] {
  const result = runMigrationCommand("status", databasePath);
  expect(result.status).toBe(0);
  return result.stdout.trim().split("\n");
}

function readTableNames(databasePath: string): string[] {
  return readRows(
    databasePath,
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;",
  ).map((row) => String(row.name));
}

function readApplicationRows(databasePath: string): Record<string, Array<Record<string, unknown>>> {
  const result = runBun(
    [
      "-e",
      `import { Database } from "bun:sqlite";
const db = new Database(process.env.NUSEND_DB_PATH, { readonly: true, strict: true });
const tables = JSON.parse(process.env.NUSEND_TEST_TABLES);
const rows = Object.fromEntries(tables.map((table) => [table, db.query(\`SELECT * FROM "\${table}" ORDER BY rowid\`).all()]));
console.log(JSON.stringify(rows));
db.close();`,
    ],
    databasePath,
    { NUSEND_TEST_TABLES: JSON.stringify(applicationTables) },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, Array<Record<string, unknown>>>;
}

function readRows(databasePath: string, sql: string): Array<Record<string, unknown>> {
  const result = runBun(
    [
      "-e",
      "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH, { readonly: true, strict: true }); const rows = db.query(process.env.NUSEND_TEST_SQL).all(); console.log(JSON.stringify(rows)); db.close();",
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

function readSchemaContract(databasePath: string): {
  columns: Record<
    string,
    Array<{
      declaredType: string;
      defaultValue: string | null;
      name: string;
      notNull: number;
      primaryKeyPosition: number;
    }>
  >;
  foreignKeyCheck: Array<Record<string, unknown>>;
  foreignKeys: Array<Record<string, unknown>>;
  indexes: Record<string, unknown>;
  tables: string[];
  tableSql: Record<string, string>;
} {
  const result = runBun(
    [
      "-e",
      `import { Database } from "bun:sqlite";
const db = new Database(process.env.NUSEND_DB_PATH, { readonly: true, strict: true });
const tables = db.query("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name <> 'schema_migrations' ORDER BY name").all();
const normalizeSql = (sql) => String(sql).replace(/\\s+/g, " ").replace(/\\(\\s+/g, "(").replace(/\\s+\\)/g, ")").trim();
const tableSql = Object.fromEntries(tables.map((row) => [row.name, normalizeSql(row.sql)]));
const columns = Object.fromEntries(tables.map((row) => [row.name, db.query(\`PRAGMA table_info(\${JSON.stringify(row.name)})\`).all().map((column) => ({
  declaredType: column.type,
  defaultValue: column.dflt_value === null ? null : normalizeSql(column.dflt_value),
  name: column.name,
  notNull: column.notnull,
  primaryKeyPosition: column.pk,
}))]));
const indexRows = db.query("SELECT name, tbl_name AS owner, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all();
const indexes = {};
for (const row of indexRows) {
  const listed = db.query(\`PRAGMA index_list(\${JSON.stringify(row.owner)})\`).all().find((item) => item.name === row.name);
  const body = row.sql.match(/\\((.*)\\)(?:\\s+WHERE\\s+|$)/s)?.[1] ?? "";
  const expressions = body.split(",").map((part) => part.trim());
  const keys = db.query(\`PRAGMA index_xinfo(\${JSON.stringify(row.name)})\`).all().filter((item) => item.key === 1).map((item) => ({
    collation: item.coll,
    column: item.name,
    direction: item.desc === 1 ? "DESC" : "ASC",
    expression: item.name === null ? expressions[item.seqno] : null,
  }));
  const predicate = row.sql.match(/\\bWHERE\\s+(.+)$/is)?.[1].replace(/\\s+/g, " ").trim() ?? null;
  indexes[row.name] = { keys, owner: row.owner, predicate, unique: listed.unique === 1 };
}
const foreignKeys = tables.flatMap((row) => db.query(\`PRAGMA foreign_key_list(\${JSON.stringify(row.name)})\`).all().map((key) => ({
  childColumn: key.from,
  childTable: row.name,
  match: key.match,
  onDelete: key.on_delete,
  onUpdate: key.on_update,
  parentColumn: key.to,
  parentTable: key.table,
}))).sort((left, right) =>
  (left.childTable + ":" + left.childColumn).localeCompare(right.childTable + ":" + right.childColumn));
console.log(JSON.stringify({
  columns,
  foreignKeyCheck: db.query("PRAGMA foreign_key_check").all(),
  foreignKeys,
  indexes,
  tables: tables.map((row) => row.name),
  tableSql,
}));
db.close();`,
    ],
    databasePath,
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as ReturnType<typeof readSchemaContract>;
}

function restoreMigrationChecksum(databasePath: string): void {
  const result = runBun(
    [
      "-e",
      "import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs'; import { Database } from 'bun:sqlite'; const checksum = createHash('sha256').update(readFileSync('src/db/migrations/sql/0001_initial_schema.sql')).digest('hex'); const db = new Database(process.env.NUSEND_DB_PATH, { strict: true }); db.query(\"UPDATE schema_migrations SET checksum = $checksum WHERE version = '0001_initial_schema'\").run({ checksum }); db.close();",
    ],
    databasePath,
  );
  expect(result.status).toBe(0);
}

function runSql(databasePath: string, sql: string) {
  return runBun(
    [
      "-e",
      "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH, { strict: true }); db.run('PRAGMA foreign_keys = ON'); db.exec(process.env.NUSEND_TEST_SQL); db.close();",
    ],
    databasePath,
    { NUSEND_TEST_SQL: sql },
  );
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
