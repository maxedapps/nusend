import { Effect } from "effect";

import type { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";

export type SeedSubscribedContactOptions = {
  readonly contactId?: string;
  readonly email?: string;
  readonly listId: string;
  readonly listName?: string;
  readonly now?: string;
};

export function seedSubscribedContact(
  options: SeedSubscribedContactOptions,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  const contactId = options.contactId ?? "contact_1";
  const email = options.email ?? "user@example.com";
  const listName = options.listName ?? "List";
  const now = options.now ?? "2026-07-03T12:00:00.000Z";

  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.run(
      "seed:list",
      "INSERT INTO lists (id, name, created_at) VALUES ($listId, $listName, $now);",
      { listId: options.listId, listName, now },
    );
    yield* db.run(
      "seed:contact",
      "INSERT INTO contacts (id, email, created_at, updated_at) VALUES ($contactId, $email, $now, $now);",
      { contactId, email, now },
    );
    yield* db.run(
      "seed:membership",
      `INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at)
       VALUES ($listId, $contactId, $now, NULL);`,
      { contactId, listId: options.listId, now },
    );
  });
}
