import { chunkValues, placeholders } from "../lib/d1-batch.ts";
import { buildInsertJobStatement } from "../queue/jobs.ts";
import { nowIso } from "../queue/time.ts";
import { buildAudienceStatements, expandJobPriority } from "./pipeline.ts";
import { findSuppressedEmails } from "./suppressions.ts";
import type { CreateMailingInput, MailingPurpose } from "./validation.ts";

type CreateMailingOptions = {
  createId?: () => string;
  now?: () => string;
};

export type CreateMailingResult = {
  counts: {
    deliveries: number;
    queued: number;
    suppressed: number;
  };
  mailing: {
    id: string;
    purpose: MailingPurpose;
    scheduledAt: string;
    state: "scheduled";
  };
};

export type CreateMailingErrorCode = "empty_recipient_set" | "list_not_found";

export class CreateMailingError extends Error {
  readonly code: CreateMailingErrorCode;

  constructor(code: CreateMailingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CreateMailingError";
  }
}

export async function createMailing(
  db: D1Database,
  input: CreateMailingInput,
  options: CreateMailingOptions = {},
): Promise<CreateMailingResult> {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now?.() ?? nowIso();
  const scheduledAt = input.scheduledAt ?? now;

  if (input.recipients && input.recipients.length > 0) {
    return createDirectMailing(db, input, input.recipients, { createId, now, scheduledAt });
  }

  if (input.listId) {
    return createListMailing(db, input, input.listId, { createId, now, scheduledAt });
  }

  throw new CreateMailingError(
    "empty_recipient_set",
    "Mailing has no subscribed recipient candidates.",
  );
}

async function createDirectMailing(
  db: D1Database,
  input: CreateMailingInput,
  recipients: NonNullable<CreateMailingInput["recipients"]>,
  context: { createId: () => string; now: string; scheduledAt: string },
): Promise<CreateMailingResult> {
  const emails = recipients.map((recipient) => recipient.email);
  const [contactIds, suppressedEmails] = await Promise.all([
    findContactIdsByEmail(db, emails),
    findSuppressedEmails(db, { emails, listId: input.listId, purpose: input.purpose }),
  ]);

  if (suppressedEmails.size >= recipients.length) {
    throw new CreateMailingError(
      "empty_recipient_set",
      "Mailing has no sendable recipients after suppression checks.",
    );
  }

  const mailingId = context.createId();
  const audience = buildAudienceStatements(db, {
    createId: context.createId,
    mailingId,
    members: recipients.map((recipient) => ({
      contactId: contactIds.get(recipient.email) ?? null,
      email: recipient.email,
      varsJson: recipient.varsJson,
    })),
    now: context.now,
    purpose: input.purpose,
    runAt: context.scheduledAt,
    suppressedEmails,
  });

  await db.batch([
    buildInsertMailingStatement(db, { input, mailingId, ...context }),
    ...audience.statements,
  ]);

  return {
    counts: {
      deliveries: recipients.length,
      queued: audience.queued,
      suppressed: audience.suppressed,
    },
    mailing: {
      id: mailingId,
      purpose: input.purpose,
      scheduledAt: context.scheduledAt,
      state: "scheduled",
    },
  };
}

async function createListMailing(
  db: D1Database,
  input: CreateMailingInput,
  listId: string,
  context: { createId: () => string; now: string; scheduledAt: string },
): Promise<CreateMailingResult> {
  const list = await db.prepare("SELECT 1 FROM lists WHERE id = ?1 LIMIT 1;").bind(listId).first();

  if (!list) {
    throw new CreateMailingError("list_not_found", "List not found.");
  }

  const mailingId = context.createId();

  // Expansion snapshots the audience immediately; only the send_delivery jobs
  // it creates honor the mailing's scheduled_at.
  await db.batch([
    buildInsertMailingStatement(db, { input, mailingId, ...context }),
    buildInsertJobStatement(db, {
      id: `expand_mailing:${mailingId}`,
      kind: "expand_mailing",
      now: context.now,
      payloadJson: JSON.stringify({ mailingId }),
      priority: expandJobPriority,
      refId: mailingId,
      runAt: context.now,
    }),
  ]);

  return {
    counts: {
      deliveries: 0,
      queued: 0,
      suppressed: 0,
    },
    mailing: {
      id: mailingId,
      purpose: input.purpose,
      scheduledAt: context.scheduledAt,
      state: "scheduled",
    },
  };
}

function buildInsertMailingStatement(
  db: D1Database,
  options: { input: CreateMailingInput; mailingId: string; now: string; scheduledAt: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mailings (
         id, purpose, state, name, subject, html, text, list_id, scheduled_at, created_at, updated_at
       ) VALUES (?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?);`,
    )
    .bind(
      options.mailingId,
      options.input.purpose,
      options.input.name,
      options.input.subject,
      options.input.html,
      options.input.text,
      options.input.listId,
      options.scheduledAt,
      options.now,
      options.now,
    );
}

async function findContactIdsByEmail(
  db: D1Database,
  emails: string[],
): Promise<Map<string, string>> {
  const contactIds = new Map<string, string>();

  for (const chunk of chunkValues(emails)) {
    const result = await db
      .prepare(
        `SELECT lower(email) AS email, id FROM contacts WHERE email IN (${placeholders(chunk.length)});`,
      )
      .bind(...chunk)
      .all<{ email: string; id: string }>();

    for (const row of result.results) contactIds.set(row.email, row.id);
  }

  return contactIds;
}
