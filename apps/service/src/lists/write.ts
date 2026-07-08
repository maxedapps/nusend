import { Effect } from "effect";

import { DatabaseError, ListNotFoundError, NotFoundError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import { getList, getListRow, type ListItem } from "./read-model.ts";

export type ListWriteResult = { readonly list: ListItem };

export type ImportListContactsResult = {
  readonly counts: {
    readonly accepted: number;
    readonly alreadySubscribed: number;
    readonly contactsCreated: number;
    readonly membershipsCreated: number;
    readonly resubscribed: number;
    readonly submitted: number;
  };
  readonly items: readonly {
    readonly action: "already_subscribed" | "created" | "resubscribed" | "subscribed";
    readonly contactId: string;
    readonly email: string;
    readonly status: "subscribed";
  }[];
};

export function createList(
  name: string,
): Effect.Effect<
  ListWriteResult,
  DatabaseError | ListNotFoundError,
  DatabaseService | IdGeneratorService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;
    const now = yield* currentIso;
    const listId = yield* ids.next;

    yield* db.run(
      "lists:create",
      "INSERT INTO lists (id, name, created_at) VALUES ($id, $name, $now);",
      { id: listId, name, now },
    );

    return yield* getList(listId);
  });
}

export function updateList(
  listId: string,
  name: string,
): Effect.Effect<ListWriteResult, DatabaseError | ListNotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const list = yield* getListRow(listId);
    if (!list) return yield* Effect.fail(new ListNotFoundError({ listId }));

    yield* db.run("lists:update", "UPDATE lists SET name = $name WHERE id = $listId;", {
      listId,
      name,
    });

    return yield* getList(listId);
  });
}

export function deleteList(
  listId: string,
): Effect.Effect<void, DatabaseError | ListNotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const list = yield* getListRow(listId);
    if (!list) return yield* Effect.fail(new ListNotFoundError({ listId }));

    yield* db.run("lists:delete", "DELETE FROM lists WHERE id = $listId;", { listId });
  });
}

export function importListContacts(
  listId: string,
  emails: readonly string[],
): Effect.Effect<
  ImportListContactsResult,
  DatabaseError | ListNotFoundError,
  DatabaseService | IdGeneratorService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    return yield* db.transaction(importListContactsRows(listId, emails));
  });
}

function importListContactsRows(
  listId: string,
  emails: readonly string[],
): Effect.Effect<
  ImportListContactsResult,
  DatabaseError | ListNotFoundError,
  DatabaseService | IdGeneratorService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;
    const now = yield* currentIso;

    const list = yield* getListRow(listId);
    if (!list) return yield* Effect.fail(new ListNotFoundError({ listId }));

    const uniqueEmails = [...new Set(emails)];
    const items: {
      action: "already_subscribed" | "created" | "resubscribed" | "subscribed";
      contactId: string;
      email: string;
      status: "subscribed";
    }[] = [];
    let contactsCreated = 0;
    let membershipsCreated = 0;
    let alreadySubscribed = 0;
    let resubscribed = 0;

    for (const email of uniqueEmails) {
      let contact = yield* findContactByEmail(email);
      let contactCreated = false;
      if (!contact) {
        const contactId = yield* ids.next;
        yield* db.run(
          "lists:contacts:create-contact",
          `INSERT INTO contacts (id, email, created_at, updated_at)
           VALUES ($id, $email, $now, $now)
           ON CONFLICT(email) DO NOTHING;`,
          { email, id: contactId, now },
        );
        contact = yield* findContactByEmail(email);
        contactCreated = contact?.id === contactId;
        if (contactCreated) contactsCreated += 1;
      }

      if (!contact) {
        return yield* Effect.fail(
          new DatabaseError({
            cause: "contact was not found after import",
            operation: "lists:contacts:import",
          }),
        );
      }

      const existing = yield* db.get<{ unsubscribedAt: string | null }>(
        "lists:contacts:get-membership",
        `SELECT unsubscribed_at AS unsubscribedAt
         FROM list_memberships
         WHERE list_id = $listId AND contact_id = $contactId
         LIMIT 1;`,
        { contactId: contact.id, listId },
      );

      let action: ImportListContactsResult["items"][number]["action"];
      if (!existing) {
        yield* db.run(
          "lists:contacts:create-membership",
          `INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at)
           VALUES ($listId, $contactId, $now, NULL);`,
          { contactId: contact.id, listId, now },
        );
        membershipsCreated += 1;
        action = contactCreated ? "created" : "subscribed";
      } else if (existing.unsubscribedAt === null) {
        alreadySubscribed += 1;
        action = "already_subscribed";
      } else {
        yield* db.run(
          "lists:contacts:resubscribe",
          `UPDATE list_memberships
           SET subscribed_at = $now, unsubscribed_at = NULL
           WHERE list_id = $listId AND contact_id = $contactId;`,
          { contactId: contact.id, listId, now },
        );
        resubscribed += 1;
        action = "resubscribed";
      }

      items.push({ action, contactId: contact.id, email: contact.email, status: "subscribed" });
    }

    return {
      counts: {
        accepted: uniqueEmails.length,
        alreadySubscribed,
        contactsCreated,
        membershipsCreated,
        resubscribed,
        submitted: emails.length,
      },
      items,
    };
  });
}

export function unsubscribeListContact(
  listId: string,
  contactId: string,
): Effect.Effect<void, DatabaseError | ListNotFoundError | NotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;
    const list = yield* getListRow(listId);
    if (!list) return yield* Effect.fail(new ListNotFoundError({ listId }));

    const updated = yield* db.get<{ contactId: string }>(
      "lists:contacts:unsubscribe",
      `UPDATE list_memberships
       SET unsubscribed_at = COALESCE(unsubscribed_at, $now)
       WHERE list_id = $listId AND contact_id = $contactId
       RETURNING contact_id AS contactId;`,
      { contactId, listId, now },
    );

    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({ message: "Contact is not a member of this list." }),
      );
    }
  });
}

type ContactLookup = { readonly email: string; readonly id: string };

function findContactByEmail(
  email: string,
): Effect.Effect<ContactLookup | null, DatabaseError, DatabaseService> {
  return Effect.flatMap(Database, (db) =>
    db.get<ContactLookup>(
      "lists:contacts:find-contact",
      "SELECT id, lower(email) AS email FROM contacts WHERE email = $email COLLATE NOCASE LIMIT 1;",
      { email },
    ),
  );
}
