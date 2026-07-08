import { Effect, Option } from "effect";

import type { DatabaseError } from "../errors.ts";
import type { MailingPurpose } from "../mailings/schema.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import { UnsubscribeConfig, type UnsubscribeConfigService } from "./config.ts";
import { verifyUnsubscribeToken } from "./token.ts";

export type UnsubscribeSource = "human" | "one-click";

export type UnsubscribeInspection =
  | { readonly kind: "Expired" }
  | { readonly kind: "Invalid" }
  | { readonly kind: "Valid"; readonly delivery: UnsubscribeDelivery };

export type UnsubscribeResult =
  | { readonly kind: "Expired" }
  | { readonly kind: "Invalid" }
  | {
      readonly kind: "Success";
      readonly delivery: UnsubscribeDelivery;
      readonly appliedMarketingUnsubscribe: boolean;
    };

type UnsubscribeDelivery = {
  readonly contactId: string | null;
  readonly email: string;
  readonly listId: string | null;
  readonly mailingPurpose: MailingPurpose;
};

export function inspectUnsubscribeToken(
  token: string,
): Effect.Effect<UnsubscribeInspection, DatabaseError, DatabaseService | UnsubscribeConfigService> {
  return Effect.gen(function* () {
    const unsubscribe = yield* UnsubscribeConfig;
    if (Option.isNone(unsubscribe.config)) return { kind: "Invalid" as const };
    const verified = verifyUnsubscribeToken(token, [
      unsubscribe.config.value.currentSecret,
      ...(unsubscribe.config.value.previousSecret ? [unsubscribe.config.value.previousSecret] : []),
    ]);
    if (verified.kind === "Invalid") return { kind: "Invalid" as const };

    const delivery = yield* loadUnsubscribeDelivery(verified.payload.d);
    if (!delivery) return { kind: "Expired" as const };

    return { delivery, kind: "Valid" as const };
  });
}

export function unsubscribeByToken(
  token: string,
  source: UnsubscribeSource,
): Effect.Effect<
  UnsubscribeResult,
  DatabaseError,
  DatabaseService | IdGeneratorService | UnsubscribeConfigService
> {
  return Effect.gen(function* () {
    // Accepted for one-click vs human route semantics and future audit support.
    // This milestone has no audit table, so the source is intentionally not persisted.
    void source;

    const inspected = yield* inspectUnsubscribeToken(token);
    if (inspected.kind !== "Valid") return inspected;
    if (inspected.delivery.mailingPurpose !== "marketing") {
      return {
        appliedMarketingUnsubscribe: false,
        delivery: inspected.delivery,
        kind: "Success" as const,
      };
    }

    const db = yield* Database;
    yield* db.transaction(writeMarketingUnsubscribe(inspected.delivery));
    return {
      appliedMarketingUnsubscribe: true,
      delivery: inspected.delivery,
      kind: "Success" as const,
    };
  });
}

function loadUnsubscribeDelivery(
  deliveryId: string,
): Effect.Effect<UnsubscribeDelivery | null, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    return yield* db.get<UnsubscribeDelivery>(
      "unsubscribe:delivery",
      `SELECT deliveries.email AS email,
              deliveries.contact_id AS contactId,
              mailings.list_id AS listId,
              mailings.purpose AS mailingPurpose
       FROM deliveries
       INNER JOIN mailings ON mailings.id = deliveries.mailing_id
       WHERE deliveries.id = $deliveryId
       LIMIT 1;`,
      { deliveryId },
    );
  });
}

function writeMarketingUnsubscribe(
  delivery: UnsubscribeDelivery,
): Effect.Effect<void, DatabaseError, DatabaseService | IdGeneratorService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;
    const now = yield* currentIso;

    yield* db.run(
      "unsubscribe:suppression:insert",
      `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
       VALUES ($id, $email, 'marketing', NULL, 'unsubscribe', $now)
       ON CONFLICT(email, scope) WHERE list_id IS NULL DO NOTHING;`,
      { email: delivery.email, id: yield* ids.next, now },
    );

    if (delivery.listId === null) return;

    const contactId = delivery.contactId ?? (yield* findContactIdByEmail(delivery.email));
    if (contactId === null) return;

    yield* db.run(
      "unsubscribe:membership:update",
      `UPDATE list_memberships
       SET unsubscribed_at = COALESCE(unsubscribed_at, $now)
       WHERE list_id = $listId
         AND contact_id = $contactId;`,
      { contactId, listId: delivery.listId, now },
    );
  });
}

function findContactIdByEmail(
  email: string,
): Effect.Effect<string | null, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{ id: string }>(
      "unsubscribe:contact:find",
      "SELECT id FROM contacts WHERE email = $email COLLATE NOCASE LIMIT 1;",
      { email },
    );
    return row?.id ?? null;
  });
}
