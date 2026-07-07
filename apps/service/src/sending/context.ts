import { Effect } from "effect";

import type { DatabaseError } from "../errors.ts";
import type { QueueJob } from "../queue/schema.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import type { DeliveryContext, DeliveryStatus } from "./schema.ts";

type DeliveryRow = {
  contactId: string | null;
  email: string;
  id: string;
  mailingId: string;
  status: DeliveryStatus;
  varsJson: string | null;
};

type MailingRow = {
  html: string;
  id: string;
  listId: string | null;
  purpose: "marketing" | "transactional";
  subject: string;
  text: string | null;
};

export function loadDeliveryContext(
  job: QueueJob,
): Effect.Effect<DeliveryContext | null, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const delivery = yield* db.get<DeliveryRow>(
      "sending:delivery:get",
      `SELECT id,
              mailing_id AS mailingId,
              email,
              contact_id AS contactId,
              vars_json AS varsJson,
              status
       FROM deliveries
       WHERE id = $deliveryId;`,
      { deliveryId: job.refId },
    );

    if (!delivery) return null;

    const mailing = yield* db.get<MailingRow>(
      "sending:mailing:get",
      `SELECT id,
              purpose,
              subject,
              html,
              text,
              list_id AS listId
       FROM mailings
       WHERE id = $mailingId;`,
      { mailingId: delivery.mailingId },
    );

    if (!mailing) return null;

    return { delivery, job, mailing };
  });
}
