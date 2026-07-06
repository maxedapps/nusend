import { env } from "cloudflare:workers";

import { hashApiKey } from "../src/auth/api-keys.ts";
import type { JobKind, JobState } from "../src/queue/jobs.ts";

export const db = env.DB;

export type SeedJobOptions = {
  id: string;
  kind?: JobKind;
  state?: JobState;
  priority?: number;
  payloadJson?: string | null;
  runAt?: string;
  attempts?: number;
  maxAttempts?: number;
  lockedBy?: string | null;
  lockedUntil?: string | null;
  refId?: string;
  createdAt?: string;
};

export async function seedJob(options: SeedJobOptions): Promise<void> {
  const createdAt = options.createdAt ?? "2026-07-03T11:00:00.000Z";
  await db
    .prepare(
      `INSERT INTO jobs (
         id, kind, state, priority, payload_json, run_at, attempts, max_attempts,
         locked_by, locked_until, ref_id, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?);`,
    )
    .bind(
      options.id,
      options.kind ?? "send_delivery",
      options.state ?? "queued",
      options.priority ?? 0,
      options.payloadJson ?? null,
      options.runAt ?? "2026-07-03T11:00:00.000Z",
      options.attempts ?? 0,
      options.maxAttempts ?? 10,
      options.lockedBy ?? null,
      options.lockedUntil ?? null,
      options.refId ?? `ref_${options.id}`,
      createdAt,
      createdAt,
    )
    .run();
}

export async function seedApiKey(
  options: { id?: string; name?: string; key?: string; revokedAt?: string | null } = {},
): Promise<string> {
  const key = options.key ?? `nusend_test_${crypto.randomUUID()}`;
  await db
    .prepare(
      "INSERT INTO api_keys (id, name, key_prefix, key_hash, revoked_at) VALUES (?, ?, ?, ?, ?);",
    )
    .bind(
      options.id ?? crypto.randomUUID(),
      options.name ?? "test",
      key.slice(0, 13),
      await hashApiKey(key),
      options.revokedAt ?? null,
    )
    .run();
  return key;
}

export async function seedList(id: string, name = id): Promise<void> {
  await db.prepare("INSERT INTO lists (id, name) VALUES (?, ?);").bind(id, name).run();
}

export async function seedContact(id: string, email: string): Promise<void> {
  await db.prepare("INSERT INTO contacts (id, email) VALUES (?, ?);").bind(id, email).run();
}

export async function seedMembership(
  listId: string,
  contactId: string,
  unsubscribedAt: string | null = null,
  subscribedAt?: string,
): Promise<void> {
  if (subscribedAt === undefined) {
    await db
      .prepare(
        "INSERT INTO list_memberships (list_id, contact_id, unsubscribed_at) VALUES (?, ?, ?);",
      )
      .bind(listId, contactId, unsubscribedAt)
      .run();
    return;
  }

  await db
    .prepare(
      "INSERT INTO list_memberships (list_id, contact_id, unsubscribed_at, subscribed_at) VALUES (?, ?, ?, ?);",
    )
    .bind(listId, contactId, unsubscribedAt, subscribedAt)
    .run();
}

export async function seedSuppression(options: {
  id?: string;
  email: string;
  scope?: "all" | "marketing" | "list";
  listId?: string | null;
  reason?: string;
}): Promise<void> {
  await db
    .prepare("INSERT INTO suppressions (id, email, scope, list_id, reason) VALUES (?, ?, ?, ?, ?);")
    .bind(
      options.id ?? crypto.randomUUID(),
      options.email,
      options.scope ?? "all",
      options.listId ?? null,
      options.reason ?? "manual",
    )
    .run();
}

export async function seedMailing(options: {
  id: string;
  purpose?: "transactional" | "marketing";
  state?: string;
  subject?: string;
  html?: string;
  listId?: string | null;
  scheduledAt?: string | null;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mailings (id, purpose, state, subject, html, list_id, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
    )
    .bind(
      options.id,
      options.purpose ?? "marketing",
      options.state ?? "scheduled",
      options.subject ?? "Subject",
      options.html ?? "<p>Hello</p>",
      options.listId ?? null,
      options.scheduledAt ?? null,
    )
    .run();
}

export async function selectAll<T = Record<string, unknown>>(
  sql: string,
  ...params: (string | number | null)[]
): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return result.results;
}

export async function selectSingle<T = Record<string, unknown>>(
  sql: string,
  ...params: (string | number | null)[]
): Promise<T | null> {
  return await db
    .prepare(sql)
    .bind(...params)
    .first<T>();
}
