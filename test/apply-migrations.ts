import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

// Setup files run outside per-test-file storage isolation and may run more
// than once; applyD1Migrations only applies migrations that are still missing.
const testEnv = env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

// Storage is only isolated per test file; start every test with empty tables
// (children before parents to satisfy foreign keys).
const tables = [
  "ses_events",
  "send_attempts",
  "jobs",
  "deliveries",
  "suppressions",
  "mailings",
  "list_memberships",
  "contacts",
  "lists",
  "api_keys",
];

beforeEach(async () => {
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM ${table};`)));
});
