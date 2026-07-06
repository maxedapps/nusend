import { buildChunkedInsertStatements, chunkValues, placeholders } from "../lib/d1-batch.ts";
import type { MailingPurpose } from "./validation.ts";

export type AudienceMember = {
  email: string;
  contactId: string | null;
  varsJson: string | null;
};

type DeliveryRow = AudienceMember & {
  id: string;
  mailingId: string;
  status: "queued" | "suppressed";
};

// Queue priority policy: transactional sends must never queue behind large
// campaign backlogs; expansion work itself never competes with sends.
export const expandJobPriority = 0;

function sendJobPriority(purpose: MailingPurpose): number {
  return purpose === "transactional" ? 10 : 0;
}

// Turns an audience chunk into the delivery + send-job insert statements.
// Suppressed members get a suppressed delivery row and no send job.
export function buildAudienceStatements(
  db: D1Database,
  options: {
    mailingId: string;
    purpose: MailingPurpose;
    members: AudienceMember[];
    suppressedEmails: Set<string>;
    runAt: string;
    now: string;
    createId: () => string;
  },
): { statements: D1PreparedStatement[]; queued: number; suppressed: number } {
  const rows: DeliveryRow[] = options.members.map((member) => ({
    ...member,
    id: options.createId(),
    mailingId: options.mailingId,
    status: options.suppressedEmails.has(member.email) ? "suppressed" : "queued",
  }));
  const queuedEmails = rows.filter((row) => row.status === "queued").map((row) => row.email);

  return {
    queued: queuedEmails.length,
    statements: [
      ...buildInsertDeliveryStatements(db, rows, options.now),
      ...buildInsertSendJobStatements(db, {
        emails: queuedEmails,
        mailingId: options.mailingId,
        now: options.now,
        purpose: options.purpose,
        runAt: options.runAt,
      }),
    ],
    suppressed: rows.length - queuedEmails.length,
  };
}

// Delivery inserts use OR IGNORE plus the unique (mailing_id, email) index so
// at-least-once retries of the same chunk never create duplicate deliveries.
function buildInsertDeliveryStatements(
  db: D1Database,
  rows: DeliveryRow[],
  now: string,
): D1PreparedStatement[] {
  return buildChunkedInsertStatements(
    db,
    rows.map((row) => [
      row.id,
      row.mailingId,
      row.email,
      row.contactId,
      row.varsJson,
      row.status,
      now,
      now,
    ]),
    (rowPlaceholders) =>
      `INSERT OR IGNORE INTO deliveries (
        id, mailing_id, email, contact_id, vars_json, status, created_at, updated_at
      ) VALUES ${rowPlaceholders};`,
  );
}

// Derives send jobs from the surviving delivery rows ('send_delivery:' + the
// delivery id), so retried chunks re-create the exact same job ids and the
// OR IGNORE keeps the queue duplicate-free.
function buildInsertSendJobStatements(
  db: D1Database,
  options: {
    mailingId: string;
    emails: string[];
    purpose: MailingPurpose;
    runAt: string;
    now: string;
  },
): D1PreparedStatement[] {
  return chunkValues(options.emails).map((emails) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO jobs (
           id, kind, state, priority, payload_json, run_at, max_attempts, ref_id, created_at, updated_at
         )
         SELECT 'send_delivery:' || d.id, 'send_delivery', 'queued', ?, NULL, ?, 10, d.id, ?, ?
         FROM deliveries d
         WHERE d.mailing_id = ?
           AND d.status = 'queued'
           AND d.email IN (${placeholders(emails.length)});`,
      )
      .bind(
        sendJobPriority(options.purpose),
        options.runAt,
        options.now,
        options.now,
        options.mailingId,
        ...emails,
      ),
  );
}
