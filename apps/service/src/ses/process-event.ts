import { Effect } from "effect";

import { DatabaseError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import { SesOperationsConfig, type SesOperationsConfigService } from "./config.ts";
import {
  SesOperationsDisabledError,
  SesOperationsForbiddenError,
  SesOperationsMalformedError,
  SnsConfirmationError,
  type SesWebhookError,
} from "./errors.ts";
import { decodeSesEvent, type SesEvent, type SesRecipient } from "./event-schema.ts";
import { SnsSubscriptionConfirmer, type SnsSubscriptionConfirmerService } from "./sns-confirmer.ts";
import { decodeUnverifiedSnsEnvelopeString, type VerifiedSnsEnvelope } from "./sns-schema.ts";
import { SnsMessageVerifier, type SnsMessageVerifierService } from "./sns-verifier.ts";

export type SesWebhookServices =
  | SesOperationsConfigService
  | SnsMessageVerifierService
  | SnsSubscriptionConfirmerService
  | DatabaseService
  | IdGeneratorService;

export function handleSesSnsRequest(
  rawBody: string,
): Effect.Effect<void, SesWebhookError | DatabaseError, SesWebhookServices> {
  return Effect.gen(function* () {
    const settings = yield* SesOperationsConfig;
    if (settings.config.feedbackTopicArns.length === 0) {
      return yield* Effect.fail(new SesOperationsDisabledError());
    }

    yield* decodeUnverifiedSnsEnvelopeString(rawBody);

    const verifier = yield* SnsMessageVerifier;
    const verified = yield* verifier.verify(rawBody);

    yield* Effect.logInfo("ses sns message verified", {
      messageId: verified.MessageId,
      snsType: verified.Type,
    });

    if (!settings.config.feedbackTopicArns.includes(verified.TopicArn)) {
      return yield* Effect.fail(
        new SesOperationsForbiddenError({ reason: "SNS TopicArn is not allowlisted." }),
      );
    }

    switch (verified.Type) {
      case "SubscriptionConfirmation":
        return yield* handleSubscriptionConfirmation(rawBody, verified);
      case "UnsubscribeConfirmation":
        return yield* insertNotificationOnly(rawBody, verified, null, null);
      case "Notification":
        return yield* handleNotification(rawBody, verified);
    }
  });
}

function handleSubscriptionConfirmation(
  rawBody: string,
  envelope: VerifiedSnsEnvelope,
): Effect.Effect<
  void,
  SnsConfirmationError | DatabaseError,
  DatabaseService | SnsSubscriptionConfirmerService | IdGeneratorService
> {
  return Effect.gen(function* () {
    if (!envelope.SubscribeURL) {
      return yield* Effect.fail(
        new SnsConfirmationError({ reason: "Subscription confirmation omitted SubscribeURL." }),
      );
    }

    const confirmer = yield* SnsSubscriptionConfirmer;
    yield* confirmer.confirm({ subscribeUrl: envelope.SubscribeURL, topicArn: envelope.TopicArn });
    yield* insertNotificationOnly(rawBody, envelope, null, null);
  });
}

function handleNotification(
  rawBody: string,
  envelope: VerifiedSnsEnvelope,
): Effect.Effect<
  void,
  SesOperationsMalformedError | DatabaseError,
  DatabaseService | IdGeneratorService
> {
  return Effect.gen(function* () {
    const now = yield* currentIso;
    const notificationId =
      (yield* insertNotificationIfNew(rawBody, envelope, null, null, now)) ??
      (yield* findUnprocessedNotificationId(envelope.MessageId));
    if (notificationId === null) return;

    const event = yield* decodeSesEvent(envelope.Message);
    const db = yield* Database;

    yield* db.transaction(
      Effect.gen(function* () {
        yield* updateNotificationEventMetadata(
          notificationId,
          event.eventType,
          event.mail.messageId,
        );
        const eventRows = eventRowsForEvent(event);
        for (const [index, row] of eventRows.entries()) {
          yield* insertEventRow(db, notificationId, envelope.MessageId, event, row, index, now);
        }
      }),
    );
  });
}

function insertNotificationOnly(
  rawBody: string,
  envelope: VerifiedSnsEnvelope,
  eventType: string | null,
  sesMessageId: string | null,
): Effect.Effect<void, DatabaseError, DatabaseService | IdGeneratorService> {
  return Effect.gen(function* () {
    const now = yield* currentIso;
    yield* insertNotificationIfNew(rawBody, envelope, eventType, sesMessageId, now);
  });
}

function insertNotificationIfNew(
  rawBody: string,
  envelope: VerifiedSnsEnvelope,
  eventType: string | null,
  sesMessageId: string | null,
  now: string,
): Effect.Effect<string | null, DatabaseError, DatabaseService | IdGeneratorService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;
    const id = yield* ids.next;
    const inserted = yield* db.get<{ id: string }>(
      "ses:notification:insert",
      `INSERT INTO ses_notifications (
         id, sns_message_id, sns_topic_arn, sns_type, event_type, ses_message_id, raw_json, received_at
       ) VALUES (
         $id, $messageId, $topicArn, $type, $eventType, $sesMessageId, $rawJson, $receivedAt
       ) ON CONFLICT(sns_message_id) DO NOTHING
       RETURNING id;`,
      {
        eventType,
        id,
        messageId: envelope.MessageId,
        rawJson: rawBody,
        receivedAt: now,
        sesMessageId,
        topicArn: envelope.TopicArn,
        type: envelope.Type,
      },
    );
    if (inserted?.id) {
      yield* Effect.logInfo("ses notification inserted", {
        notificationId: inserted.id,
        snsMessageId: envelope.MessageId,
        snsType: envelope.Type,
      });
    } else {
      yield* Effect.logInfo("ses notification duplicate skipped", {
        snsMessageId: envelope.MessageId,
        snsType: envelope.Type,
      });
    }
    return inserted?.id ?? null;
  });
}

// The audit row commits before the event transaction, so a crash or DB error
// between the two leaves a stored Notification without event metadata or rows.
// SNS redelivers such messages; treat that dedupe hit as unfinished work, not
// as already processed. Malformed payloads also match (metadata stays NULL),
// so each redelivery re-attempts the decode and keeps returning 400.
function findUnprocessedNotificationId(
  snsMessageId: string,
): Effect.Effect<string | null, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{ id: string }>(
      "ses:notification:find-unprocessed",
      `SELECT id FROM ses_notifications
       WHERE sns_message_id = $snsMessageId
         AND sns_type = 'Notification'
         AND event_type IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ses_events WHERE ses_events.notification_id = ses_notifications.id
         )
       LIMIT 1;`,
      { snsMessageId },
    );
    if (row) {
      yield* Effect.logInfo("ses notification reprocessing unprocessed duplicate", {
        notificationId: row.id,
        snsMessageId,
      });
    }
    return row?.id ?? null;
  });
}

function updateNotificationEventMetadata(
  notificationId: string,
  eventType: string,
  sesMessageId: string,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.flatMap(Database, (db) =>
    db.run(
      "ses:notification:update-event-metadata",
      `UPDATE ses_notifications
       SET event_type = $eventType, ses_message_id = $sesMessageId
       WHERE id = $notificationId;`,
      { eventType, notificationId, sesMessageId },
    ),
  );
}

type EventRowSeed = {
  readonly actionTaken: "ignored" | "recorded" | "suppressed";
  readonly bounceSubType: string | null;
  readonly bounceType: string | null;
  readonly complaintFeedbackType: string | null;
  readonly diagnosticCode: string | null;
  readonly email: string | null;
  readonly feedbackId: string | null;
  readonly ipAddress: string | null;
  readonly linkTagsJson: string | null;
  readonly linkUrl: string | null;
  readonly occurredAt: string | null;
  readonly rejectReason: string | null;
  readonly deliveryDelayType: string | null;
  readonly shouldSuppressReason: "bounce" | "complaint" | null;
  readonly userAgent: string | null;
};

function eventRowsForEvent(event: SesEvent): readonly EventRowSeed[] {
  switch (event.eventType) {
    case "Bounce": {
      const bounce = event.bounce;
      if (!bounce) return [];
      const permanent = bounce.bounceType === "Permanent";
      return bounce.bouncedRecipients.map((recipient) =>
        Object.assign(
          baseRow(recipient.emailAddress, bounce.timestamp ?? event.mail.timestamp ?? null),
          {
            actionTaken: permanent ? "suppressed" : "recorded",
            bounceSubType: bounce.bounceSubType ?? null,
            bounceType: bounce.bounceType ?? null,
            diagnosticCode: recipient.diagnosticCode ?? null,
            feedbackId: bounce.feedbackId ?? null,
            shouldSuppressReason: permanent ? "bounce" : null,
          } satisfies Partial<EventRowSeed>,
        ),
      );
    }
    case "Complaint": {
      const complaint = event.complaint;
      if (!complaint) return [];
      const notSpam = complaint.complaintFeedbackType === "not-spam";
      return complaint.complainedRecipients.map((recipient) =>
        Object.assign(
          baseRow(recipient.emailAddress, complaint.timestamp ?? event.mail.timestamp ?? null),
          {
            actionTaken: notSpam ? "recorded" : "suppressed",
            complaintFeedbackType: complaint.complaintFeedbackType ?? null,
            diagnosticCode: recipient.diagnosticCode ?? null,
            feedbackId: complaint.feedbackId ?? null,
            shouldSuppressReason: notSpam ? null : "complaint",
          } satisfies Partial<EventRowSeed>,
        ),
      );
    }
    case "DeliveryDelay":
      return (event.deliveryDelay?.delayedRecipients ?? []).map((recipient) =>
        Object.assign(
          recipientRow(recipient, event.deliveryDelay?.timestamp ?? event.mail.timestamp ?? null),
          {
            deliveryDelayType: event.deliveryDelay?.delayType ?? null,
          } satisfies Partial<EventRowSeed>,
        ),
      );
    case "Delivery":
      return (event.delivery?.recipients ?? []).map((email) =>
        baseRow(email, event.delivery?.timestamp ?? event.mail.timestamp ?? null),
      );
    case "Reject":
      return event.mail.destination.map((email) =>
        Object.assign(baseRow(email, event.mail.timestamp ?? null), {
          rejectReason: event.reject?.reason ?? null,
        } satisfies Partial<EventRowSeed>),
      );
    case "Open":
      return [
        {
          ...baseRow(
            firstDestination(event),
            event.open?.timestamp ?? event.mail.timestamp ?? null,
          ),
          ipAddress: event.open?.ipAddress ?? null,
          userAgent: event.open?.userAgent ?? null,
        },
      ];
    case "Click":
      return [
        {
          ...baseRow(
            firstDestination(event),
            event.click?.timestamp ?? event.mail.timestamp ?? null,
          ),
          ipAddress: event.click?.ipAddress ?? null,
          linkTagsJson: event.click?.linkTags ? JSON.stringify(event.click.linkTags) : null,
          linkUrl: event.click?.link ?? null,
          userAgent: event.click?.userAgent ?? null,
        },
      ];
    case "Send":
    case "Rendering Failure":
    case "Subscription":
    case "Unknown":
      return event.mail.destination.length > 0
        ? event.mail.destination.map((email) => baseRow(email, event.mail.timestamp ?? null))
        : [baseRow(null, event.mail.timestamp ?? null)];
  }
}

function firstDestination(event: SesEvent): string | null {
  return event.mail.destination[0] ?? null;
}

function recipientRow(recipient: SesRecipient, occurredAt: string | null): EventRowSeed {
  return {
    ...baseRow(recipient.emailAddress, occurredAt),
    diagnosticCode: recipient.diagnosticCode ?? null,
  };
}

function baseRow(email: string | null, occurredAt: string | null): EventRowSeed {
  return {
    actionTaken: "recorded",
    bounceSubType: null,
    bounceType: null,
    complaintFeedbackType: null,
    deliveryDelayType: null,
    diagnosticCode: null,
    email,
    feedbackId: null,
    ipAddress: null,
    linkTagsJson: null,
    linkUrl: null,
    occurredAt,
    rejectReason: null,
    shouldSuppressReason: null,
    userAgent: null,
  };
}

function insertEventRow(
  db: DatabaseService,
  notificationId: string,
  snsMessageId: string,
  event: SesEvent,
  row: EventRowSeed,
  index: number,
  now: string,
): Effect.Effect<void, DatabaseError, IdGeneratorService> {
  return Effect.gen(function* () {
    const normalizedEmail = row.email?.trim().toLowerCase() || null;
    const resolved = yield* resolveDelivery(db, event, normalizedEmail);
    const idGenerator = yield* IdGenerator;
    const eventId = yield* idGenerator.next;
    const dedupeKey = `${snsMessageId}:${event.eventType}:${normalizedEmail ?? ""}:${row.linkUrl ?? ""}:${index}`;

    yield* db.run(
      "ses:event:insert",
      `INSERT INTO ses_events (
         id, dedupe_key, notification_id, event_type, delivery_id, mailing_id, ses_message_id,
         recipient_email, action_taken, occurred_at, bounce_type, bounce_sub_type,
         complaint_feedback_type, feedback_id, diagnostic_code, reject_reason, delivery_delay_type,
         link_url, link_tags_json, ip_address, user_agent, created_at
       ) VALUES (
         $id, $dedupeKey, $notificationId, $eventType, $deliveryId, $mailingId, $sesMessageId,
         $recipientEmail, $actionTaken, $occurredAt, $bounceType, $bounceSubType,
         $complaintFeedbackType, $feedbackId, $diagnosticCode, $rejectReason, $deliveryDelayType,
         $linkUrl, $linkTagsJson, $ipAddress, $userAgent, $createdAt
       ) ON CONFLICT(dedupe_key) DO NOTHING;`,
      {
        actionTaken: row.actionTaken,
        bounceSubType: row.bounceSubType,
        bounceType: row.bounceType,
        complaintFeedbackType: row.complaintFeedbackType,
        createdAt: now,
        dedupeKey,
        deliveryDelayType: row.deliveryDelayType,
        deliveryId: resolved?.deliveryId ?? null,
        diagnosticCode: row.diagnosticCode,
        eventType: event.eventType,
        feedbackId: row.feedbackId,
        id: eventId,
        ipAddress: row.ipAddress,
        linkTagsJson: row.linkTagsJson,
        linkUrl: row.linkUrl,
        mailingId: resolved?.mailingId ?? null,
        notificationId,
        occurredAt: row.occurredAt,
        recipientEmail: normalizedEmail,
        rejectReason: row.rejectReason,
        sesMessageId: event.mail.messageId,
        userAgent: row.userAgent,
      },
    );

    yield* Effect.logInfo("ses event row processed", {
      actionTaken: row.actionTaken,
      deliveryId: resolved?.deliveryId ?? null,
      eventType: event.eventType,
      mailingId: resolved?.mailingId ?? null,
    });

    if (row.shouldSuppressReason && normalizedEmail) {
      const suppressionId = yield* idGenerator.next;
      yield* db.run(
        "ses:suppression:insert",
        `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
         VALUES ($id, $email, 'all', NULL, $reason, $createdAt)
         ON CONFLICT(email, scope) WHERE list_id IS NULL DO NOTHING;`,
        {
          createdAt: now,
          email: normalizedEmail,
          id: suppressionId,
          reason: row.shouldSuppressReason,
        },
      );
      yield* Effect.logInfo("ses suppression recorded", {
        reason: row.shouldSuppressReason,
        scope: "all",
      });
    }
  });
}

type ResolvedDelivery = { readonly deliveryId: string; readonly mailingId: string };
type DeliveryRow = { readonly id: string; readonly mailingId: string };

function resolveDelivery(
  db: DatabaseService,
  event: SesEvent,
  recipientEmail: string | null,
): Effect.Effect<ResolvedDelivery | null, DatabaseError> {
  return Effect.gen(function* () {
    const taggedDeliveryId = firstTagValue(event.mail.tags, "delivery_id");
    if (taggedDeliveryId && recipientEmail) {
      const tagged = yield* db.get<DeliveryRow>(
        "ses:delivery:resolve-by-tag",
        `SELECT id, mailing_id AS mailingId
         FROM deliveries
         WHERE id = $deliveryId AND lower(email) = lower($email)
         LIMIT 1;`,
        { deliveryId: taggedDeliveryId, email: recipientEmail },
      );
      if (tagged) return { deliveryId: tagged.id, mailingId: tagged.mailingId };
    }

    const bySesMessageId = yield* db.get<DeliveryRow>(
      "ses:delivery:resolve-by-ses-message-id",
      `SELECT id, mailing_id AS mailingId
       FROM deliveries
       WHERE ses_message_id = $sesMessageId
       LIMIT 1;`,
      { sesMessageId: event.mail.messageId },
    );

    return bySesMessageId
      ? { deliveryId: bySesMessageId.id, mailingId: bySesMessageId.mailingId }
      : null;
  });
}

function firstTagValue(
  tags: Record<string, readonly string[]> | undefined,
  key: string,
): string | null {
  const value = tags?.[key]?.[0]?.trim();
  return value && value.length > 0 ? value : null;
}
