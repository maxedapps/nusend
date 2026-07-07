// Create a mailing: resolve recipients, apply suppression rules, and insert the
// mailing + delivery + job rows — reads and writes inside ONE interactive
// transaction (DB-only work, per the Database.transaction policy).
import { Effect } from "effect";

import {
  EmptyRecipientSetError,
  ListNotFoundError,
  RecipientLimitExceededError,
  type DatabaseError,
} from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import type { CreateMailingInput, MailingPurpose } from "./schema.ts";

export const maxListRecipients = 5000;
export const suppressionBatchSize = 500;
const contactLookupBatchSize = 500;

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

const insertMailingSql = `INSERT INTO mailings (
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
);`;

const insertDeliverySql = `INSERT INTO deliveries (
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
);`;

const insertJobSql = `INSERT INTO jobs (
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
);`;

export function createMailing(
  input: CreateMailingInput,
): Effect.Effect<
  CreateMailingResult,
  DatabaseError | EmptyRecipientSetError | ListNotFoundError | RecipientLimitExceededError,
  DatabaseService | IdGeneratorService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;
    const now = yield* currentIso;
    const effectiveScheduledAt = input.scheduledAt ?? now;

    return yield* db.transaction(
      Effect.gen(function* () {
        const recipients = yield* resolveRecipients(db, input);

        if (recipients.length === 0) {
          return yield* Effect.fail(
            new EmptyRecipientSetError({
              reason: "Mailing has no subscribed recipient candidates.",
            }),
          );
        }

        const suppressedEmails = yield* findSuppressedEmails(db, {
          emails: recipients.map((recipient) => recipient.email),
          listId: input.listId,
          purpose: input.purpose,
        });

        if (suppressedEmails.size >= recipients.length) {
          return yield* Effect.fail(
            new EmptyRecipientSetError({
              reason: "Mailing has no sendable recipients after suppression checks.",
            }),
          );
        }

        const mailingId = yield* ids.next;

        yield* db.run("mailings:insert", insertMailingSql, {
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
          const deliveryId = yield* ids.next;
          const isSuppressed = suppressedEmails.has(recipient.email);
          const status = isSuppressed ? "suppressed" : "queued";

          yield* db.run("deliveries:insert", insertDeliverySql, {
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
          yield* db.run("jobs:insert", insertJobSql, {
            id: yield* ids.next,
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
      }),
    );
  });
}

function resolveRecipients(
  db: DatabaseService,
  input: CreateMailingInput,
): Effect.Effect<
  RecipientCandidate[],
  DatabaseError | ListNotFoundError | RecipientLimitExceededError
> {
  return Effect.gen(function* () {
    if (input.recipients) {
      const contactIds = yield* findContactIdsByEmail(
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

    const list = yield* db.get(
      "lists:find",
      "SELECT 1 AS ok FROM lists WHERE id = $listId LIMIT 1;",
      { listId: input.listId },
    );

    if (!list) {
      return yield* Effect.fail(new ListNotFoundError({ listId: input.listId }));
    }

    const rows = yield* db.all<{ contactId: string; email: string }>(
      "lists:recipients",
      `SELECT contacts.id AS contactId, lower(contacts.email) AS email
       FROM contacts
       INNER JOIN list_memberships ON list_memberships.contact_id = contacts.id
       WHERE list_memberships.list_id = $listId
         AND list_memberships.unsubscribed_at IS NULL
       ORDER BY contacts.email ASC
       LIMIT $limit;`,
      { limit: maxListRecipients + 1, listId: input.listId },
    );

    if (rows.length > maxListRecipients) {
      return yield* Effect.fail(new RecipientLimitExceededError({ limit: maxListRecipients }));
    }

    return rows.map((row) => ({ contactId: row.contactId, email: row.email, varsJson: null }));
  });
}

function findContactIdsByEmail(
  db: DatabaseService,
  emails: string[],
): Effect.Effect<Map<string, string>, DatabaseError> {
  if (emails.length === 0) return Effect.succeed(new Map());

  return Effect.gen(function* () {
    const rows = yield* Effect.forEach(chunks(emails, contactLookupBatchSize), (chunk, index) =>
      db.all<{ email: string; id: string }>(
        `contacts:find-by-email:${index}`,
        `SELECT lower(email) AS email, id
         FROM contacts
         WHERE email IN (${createPlaceholders(chunk, "email")});`,
        createParams(chunk, "email"),
      ),
    );

    return new Map(rows.flat().map((row) => [row.email, row.id]));
  });
}

function findSuppressedEmails(
  db: DatabaseService,
  input: { emails: string[]; listId: null | string; purpose: MailingPurpose },
): Effect.Effect<Set<string>, DatabaseError> {
  if (input.emails.length === 0) return Effect.succeed(new Set());

  return Effect.gen(function* () {
    const isMarketing = input.purpose === "marketing";
    const scopePredicate = isMarketing
      ? "(scope IN ('all', 'marketing') OR (scope = 'list' AND list_id = $listId))"
      : "scope = 'all'";
    const rows = yield* Effect.forEach(
      chunks(input.emails, suppressionBatchSize),
      (chunk, index) => {
        const params = createParams(chunk, "email");
        const queryParams = isMarketing ? { ...params, listId: input.listId } : params;

        return db.all<{ email: string }>(
          `suppressions:find:${index}`,
          `SELECT lower(email) AS email
         FROM suppressions
         WHERE email IN (${createPlaceholders(chunk, "email")})
           AND ${scopePredicate};`,
          queryParams,
        );
      },
    );

    return new Set(rows.flat().map((row) => row.email));
  });
}

function createPlaceholders(values: string[], prefix: string): string {
  return values.map((_, index) => `$${prefix}${index}`).join(", ");
}

function createParams(values: string[], prefix: string): Record<string, string> {
  return Object.fromEntries(values.map((value, index) => [`${prefix}${index}`, value]));
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}
