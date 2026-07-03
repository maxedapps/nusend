import type { Database } from "bun:sqlite";

import type { CreateMailingInput, MailingPurpose } from "./validation.ts";

type CreateMailingOptions = {
  createId?: () => string;
  now?: () => string;
};

type RecipientCandidate = {
  contactId: string | null;
  email: string;
  varsJson: string | null;
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

export function createMailing(
  db: Database,
  input: CreateMailingInput,
  options: CreateMailingOptions = {},
): CreateMailingResult {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now?.() ?? new Date().toISOString();
  const effectiveScheduledAt = input.scheduledAt ?? now;

  const insertMailing = db.query(`INSERT INTO mailings (
    id,
    purpose,
    state,
    name,
    subject,
    html,
    text,
    list_id,
    scheduled_at,
    created_at,
    updated_at
  ) VALUES (
    $id,
    $purpose,
    'scheduled',
    $name,
    $subject,
    $html,
    $text,
    $listId,
    $scheduledAt,
    $now,
    $now
  );`);
  const insertDelivery = db.query(`INSERT INTO deliveries (
    id,
    mailing_id,
    email,
    contact_id,
    vars_json,
    status,
    created_at,
    updated_at
  ) VALUES (
    $id,
    $mailingId,
    $email,
    $contactId,
    $varsJson,
    $status,
    $now,
    $now
  );`);
  const insertJob = db.query(`INSERT INTO jobs (
    id,
    kind,
    state,
    run_at,
    ref_id,
    created_at,
    updated_at
  ) VALUES (
    $id,
    'send_delivery',
    'queued',
    $runAt,
    $refId,
    $now,
    $now
  );`);

  const create = db.transaction(() => {
    const recipients = resolveRecipients(db, input);

    if (recipients.length === 0) {
      throw new CreateMailingError(
        "empty_recipient_set",
        "Mailing has no subscribed recipient candidates.",
      );
    }

    const suppressedEmails = findSuppressedEmails(db, {
      emails: recipients.map((recipient) => recipient.email),
      listId: input.listId,
      purpose: input.purpose,
    });
    if (suppressedEmails.size >= recipients.length) {
      throw new CreateMailingError(
        "empty_recipient_set",
        "Mailing has no sendable recipients after suppression checks.",
      );
    }

    const mailingId = createId();

    insertMailing.run({
      html: input.html,
      id: mailingId,
      listId: input.listId,
      name: input.name,
      now,
      purpose: input.purpose,
      scheduledAt: effectiveScheduledAt,
      subject: input.subject,
      text: input.text,
    });

    let queued = 0;
    let suppressed = 0;

    for (const recipient of recipients) {
      const deliveryId = createId();
      const isSuppressed = suppressedEmails.has(recipient.email);
      const status = isSuppressed ? "suppressed" : "queued";

      insertDelivery.run({
        contactId: recipient.contactId,
        email: recipient.email,
        id: deliveryId,
        mailingId,
        now,
        status,
        varsJson: recipient.varsJson,
      });

      if (isSuppressed) {
        suppressed += 1;
        continue;
      }

      queued += 1;
      insertJob.run({
        id: createId(),
        now,
        refId: deliveryId,
        runAt: effectiveScheduledAt,
      });
    }

    return {
      counts: {
        deliveries: recipients.length,
        queued,
        suppressed,
      },
      mailing: {
        id: mailingId,
        purpose: input.purpose,
        scheduledAt: effectiveScheduledAt,
        state: "scheduled" as const,
      },
    };
  });

  return create();
}

function resolveRecipients(db: Database, input: CreateMailingInput): RecipientCandidate[] {
  if (input.recipients) {
    const contactIds = findContactIdsByEmail(
      db,
      input.recipients.map((recipient) => recipient.email),
    );

    return input.recipients.map((recipient) => ({
      contactId: contactIds.get(recipient.email) ?? null,
      email: recipient.email,
      varsJson: recipient.varsJson,
    }));
  }

  if (!input.listId) return [];

  const list = db.query("SELECT 1 FROM lists WHERE id = $listId LIMIT 1;").get({
    listId: input.listId,
  });

  if (!list) {
    throw new CreateMailingError("list_not_found", "List not found.");
  }

  const rows = db
    .query(
      `SELECT contacts.id AS contactId, lower(contacts.email) AS email
       FROM contacts
       INNER JOIN list_memberships ON list_memberships.contact_id = contacts.id
       WHERE list_memberships.list_id = $listId
         AND list_memberships.unsubscribed_at IS NULL
       ORDER BY contacts.email ASC;`,
    )
    .all({ listId: input.listId }) as { contactId: string; email: string }[];

  return rows.map((row) => ({ contactId: row.contactId, email: row.email, varsJson: null }));
}

function findContactIdsByEmail(db: Database, emails: string[]): Map<string, string> {
  if (emails.length === 0) return new Map();

  const rows = db
    .query(
      `SELECT lower(email) AS email, id
       FROM contacts
       WHERE email IN (${createPlaceholders(emails, "email")});`,
    )
    .all(createParams(emails, "email")) as { email: string; id: string }[];

  return new Map(rows.map((row) => [row.email, row.id]));
}

function findSuppressedEmails(
  db: Database,
  input: { emails: string[]; listId: null | string; purpose: MailingPurpose },
): Set<string> {
  if (input.emails.length === 0) return new Set();

  const params = createParams(input.emails, "email");
  const isMarketing = input.purpose === "marketing";
  const scopePredicate = isMarketing
    ? "(scope IN ('all', 'marketing') OR (scope = 'list' AND list_id = $listId))"
    : "scope = 'all'";
  const queryParams = isMarketing ? { ...params, listId: input.listId } : params;
  const rows = db
    .query(
      `SELECT lower(email) AS email
       FROM suppressions
       WHERE email IN (${createPlaceholders(input.emails, "email")})
         AND ${scopePredicate};`,
    )
    .all(queryParams) as { email: string }[];

  return new Set(rows.map((row) => row.email));
}

function createPlaceholders(values: string[], prefix: string): string {
  return values.map((_, index) => `$${prefix}${index}`).join(", ");
}

function createParams(values: string[], prefix: string): Record<string, string> {
  return Object.fromEntries(values.map((value, index) => [`${prefix}${index}`, value]));
}
