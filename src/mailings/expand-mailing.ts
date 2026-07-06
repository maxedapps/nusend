import type { QueueJob } from "../queue/jobs.ts";
import { buildInsertJobStatement } from "../queue/jobs.ts";
import type { JobProcessor } from "../queue/runner.ts";
import { nowIso } from "../queue/time.ts";
import { buildAudienceStatements } from "./pipeline.ts";
import { findSuppressedEmails } from "./suppressions.ts";
import type { MailingPurpose } from "./validation.ts";

export type ExpandMailingPayload = {
  mailingId: string;
  afterContactId?: string;
};

export type ExpandMailingOptions = {
  chunkSize?: number;
  createId?: () => string;
  now?: () => string;
};

type MailingRow = {
  id: string;
  purpose: MailingPurpose;
  state: string;
  listId: string | null;
  scheduledAt: string | null;
  createdAt: string;
};

const defaultChunkSize = 50;

// Expands one chunk of list members into deliveries and send_delivery jobs.
// Each chunk commits its delivery inserts, send-job inserts, and the next
// cursor job in a single batch, so an at-least-once retry either replays a
// fully-ignored chunk or resumes exactly where the last commit left off.
export function createExpandMailingProcessor(
  db: D1Database,
  options: ExpandMailingOptions = {},
): JobProcessor {
  const chunkSize = options.chunkSize ?? defaultChunkSize;
  const createId = options.createId ?? (() => crypto.randomUUID());

  return async (job) => {
    const payload = parsePayload(job);
    const now = options.now?.() ?? nowIso();
    const mailing = await db
      .prepare(
        `SELECT id, purpose, state, list_id AS listId, scheduled_at AS scheduledAt, created_at AS createdAt
         FROM mailings WHERE id = ?1;`,
      )
      .bind(payload.mailingId)
      .first<MailingRow>();

    if (!mailing) {
      throw new Error(`Mailing '${payload.mailingId}' not found.`);
    }
    if (!mailing.listId) {
      throw new Error(`Mailing '${mailing.id}' has no list to expand.`);
    }

    const members = await readMemberChunk(db, {
      afterContactId: payload.afterContactId ?? null,
      chunkSize,
      listId: mailing.listId,
      subscribedBefore: mailing.createdAt,
    });

    if (members.length === 0) return;

    const suppressedEmails = await findSuppressedEmails(db, {
      emails: members.map((member) => member.email),
      listId: mailing.listId,
      purpose: mailing.purpose,
    });
    const audience = buildAudienceStatements(db, {
      createId,
      mailingId: mailing.id,
      members: members.map((member) => ({ ...member, varsJson: null })),
      now,
      purpose: mailing.purpose,
      runAt: mailing.scheduledAt ?? now,
      suppressedEmails,
    });
    const statements = audience.statements;

    if (members.length === chunkSize) {
      const lastContactId = members[members.length - 1].contactId;
      const nextPayload: ExpandMailingPayload = {
        afterContactId: lastContactId,
        mailingId: mailing.id,
      };
      statements.push(
        buildInsertJobStatement(db, {
          id: `expand_mailing:${mailing.id}:${lastContactId}`,
          kind: "expand_mailing",
          now,
          payloadJson: JSON.stringify(nextPayload),
          priority: job.priority,
          refId: mailing.id,
          runAt: now,
        }),
      );
    }

    await db.batch(statements);
  };
}

function parsePayload(job: QueueJob): ExpandMailingPayload {
  if (!job.payloadJson) return { mailingId: job.refId };

  const parsed: unknown = JSON.parse(job.payloadJson);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Job '${job.id}' has an invalid expand_mailing payload.`);
  }

  const payload = parsed as Partial<ExpandMailingPayload>;
  return {
    afterContactId: payload.afterContactId,
    mailingId: payload.mailingId ?? job.refId,
  };
}

// The audience is pinned to mailing creation time: members who subscribed
// after the mailing was created are excluded even if expansion runs later,
// while members who unsubscribed since creation are (deliberately) dropped.
async function readMemberChunk(
  db: D1Database,
  options: {
    listId: string;
    afterContactId: string | null;
    chunkSize: number;
    subscribedBefore: string;
  },
): Promise<{ contactId: string; email: string }[]> {
  const result = await db
    .prepare(
      `SELECT contacts.id AS contactId, lower(contacts.email) AS email
       FROM contacts
       INNER JOIN list_memberships ON list_memberships.contact_id = contacts.id
       WHERE list_memberships.list_id = ?1
         AND list_memberships.unsubscribed_at IS NULL
         AND list_memberships.subscribed_at <= ?2
         AND (?3 IS NULL OR contacts.id > ?3)
       ORDER BY contacts.id ASC
       LIMIT ?4;`,
    )
    .bind(options.listId, options.subscribedBefore, options.afterContactId, options.chunkSize)
    .all<{ contactId: string; email: string }>();

  return result.results;
}
