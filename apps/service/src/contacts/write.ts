import { Effect } from "effect";

import { ConflictError, DatabaseError, NotFoundError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import { getContactRow, type Contact } from "./read-model.ts";

export type ContactWriteResult = {
  readonly contact: Contact;
};

export type CreateContactResult = ContactWriteResult & {
  readonly created: boolean;
};

export function createOrGetContact(
  email: string,
): Effect.Effect<CreateContactResult, DatabaseError, DatabaseService | IdGeneratorService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;
    const now = yield* currentIso;
    const id = yield* ids.next;

    const inserted = yield* db.get<{ id: string }>(
      "contacts:create",
      `INSERT INTO contacts (id, email, created_at, updated_at)
       VALUES ($id, $email, $now, $now)
       ON CONFLICT(email) DO NOTHING
       RETURNING id;`,
      { email, id, now },
    );

    const contact = yield* getContactByEmail(email);
    if (!contact) {
      return yield* Effect.fail(
        new DatabaseError({
          cause: "contact was not found after create",
          operation: "contacts:create",
        }),
      );
    }

    return { contact, created: inserted !== null };
  });
}

export function updateContactEmail(
  contactId: string,
  email: string,
): Effect.Effect<
  ContactWriteResult,
  ConflictError | DatabaseError | NotFoundError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    return yield* db.transaction(updateContactEmailRows(contactId, email));
  });
}

function updateContactEmailRows(
  contactId: string,
  email: string,
): Effect.Effect<
  ContactWriteResult,
  ConflictError | DatabaseError | NotFoundError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;

    const existing = yield* getContactRow(contactId);
    if (!existing) return yield* Effect.fail(new NotFoundError({ message: "Contact not found." }));

    const conflict = yield* db.get<{ id: string }>(
      "contacts:update:conflict",
      `SELECT id
       FROM contacts
       WHERE email = $email COLLATE NOCASE
         AND id <> $contactId
       LIMIT 1;`,
      { contactId, email },
    );
    if (conflict) {
      return yield* Effect.fail(
        new ConflictError({ message: "Another contact already uses this email." }),
      );
    }

    yield* db.run(
      "contacts:update",
      `UPDATE contacts
       SET email = $email, updated_at = $now
       WHERE id = $contactId;`,
      { contactId, email, now },
    );

    const contact = yield* getContactRow(contactId);
    if (!contact) return yield* Effect.fail(new NotFoundError({ message: "Contact not found." }));

    return { contact };
  });
}

export function deleteContact(
  contactId: string,
): Effect.Effect<void, DatabaseError | NotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const contact = yield* getContactRow(contactId);
    if (!contact) return yield* Effect.fail(new NotFoundError({ message: "Contact not found." }));

    yield* db.run("contacts:delete", "DELETE FROM contacts WHERE id = $contactId;", { contactId });
  });
}

function getContactByEmail(
  email: string,
): Effect.Effect<Contact | null, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{ id: string }>(
      "contacts:get-by-email-id",
      "SELECT id FROM contacts WHERE email = $email COLLATE NOCASE LIMIT 1;",
      { email },
    );
    return row ? yield* getContactRow(row.id) : null;
  });
}
