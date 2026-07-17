import { Effect } from "effect";

import type { DatabaseError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";

// `completed` means all send processing for the mailing is terminal. It does
// not mean recipient inbox delivery has been confirmed by SES events.
export function markMailingSending(
  mailingId: string,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;

    yield* db.run(
      "mailings:lifecycle:mark-sending",
      `UPDATE mailings
       SET state = 'sending', updated_at = $now
       WHERE id = $mailingId AND state = 'scheduled';`,
      { mailingId, now },
    );
  });
}

export function refreshMailingStateForDelivery(
  deliveryId: string,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;
    const delivery = yield* db.get<{ mailingId: string }>(
      "mailings:lifecycle:delivery-mailing",
      "SELECT mailing_id AS mailingId FROM deliveries WHERE id = $deliveryId;",
      { deliveryId },
    );

    if (!delivery) return;

    const counts = yield* db.get<{
      total: number;
      terminal: number;
      attempts: number;
    }>(
      "mailings:lifecycle:state-counts",
      `SELECT
         count(*) AS total,
         sum(CASE WHEN d.status IN ('sent', 'failed', 'suppressed', 'ambiguous') THEN 1 ELSE 0 END) AS terminal,
         count(sa.id) AS attempts
       FROM deliveries d
       LEFT JOIN send_attempts sa ON sa.delivery_id = d.id
       WHERE d.mailing_id = $mailingId;`,
      { mailingId: delivery.mailingId },
    );

    if (!counts || counts.total === 0) return;

    if (counts.terminal === counts.total) {
      yield* db.run(
        "mailings:lifecycle:mark-completed",
        `UPDATE mailings
         SET state = 'completed', updated_at = $now
         WHERE id = $mailingId AND state != 'completed';`,
        { mailingId: delivery.mailingId, now },
      );
      return;
    }

    if (counts.attempts > 0) {
      yield* db.run(
        "mailings:lifecycle:refresh-sending",
        `UPDATE mailings
         SET state = 'sending', updated_at = $now
         WHERE id = $mailingId AND state = 'scheduled';`,
        { mailingId: delivery.mailingId, now },
      );
      return;
    }

    yield* db.run(
      "mailings:lifecycle:refresh-scheduled",
      `UPDATE mailings
       SET state = 'scheduled', updated_at = $now
       WHERE id = $mailingId AND state != 'completed';`,
      { mailingId: delivery.mailingId, now },
    );
  });
}
