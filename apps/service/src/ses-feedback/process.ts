import { Effect, Option } from "effect";

import { DatabaseError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import { SesFeedbackConfig, type SesFeedbackConfigService } from "./config.ts";
import {
  SesFeedbackDisabledError,
  SesFeedbackForbiddenError,
  SesFeedbackMalformedError,
  SnsConfirmationError,
  type SesFeedbackError,
} from "./errors.ts";
import { decodeSesEvent, type SesEvent, type SesRecipient } from "./ses-event-schema.ts";
import { SnsSubscriptionConfirmer, type SnsSubscriptionConfirmerService } from "./sns-confirmer.ts";
import { decodeUnverifiedSnsEnvelopeString, type VerifiedSnsEnvelope } from "./sns-schema.ts";
import { SnsMessageVerifier, type SnsMessageVerifierService } from "./sns-verifier.ts";

export type SesFeedbackServices =
  | SesFeedbackConfigService
  | SnsMessageVerifierService
  | SnsSubscriptionConfirmerService
  | DatabaseService
  | IdGeneratorService;

export function handleSesFeedbackSnsRequest(
  rawBody: string,
): Effect.Effect<void, SesFeedbackError | DatabaseError, SesFeedbackServices> {
  return Effect.gen(function* () {
    const feedback = yield* SesFeedbackConfig;
    if (Option.isNone(feedback.config)) {
      return yield* Effect.fail(new SesFeedbackDisabledError());
    }

    yield* decodeUnverifiedSnsEnvelopeString(rawBody);

    const verifier = yield* SnsMessageVerifier;
    const verified = yield* verifier.verify(rawBody);

    if (!feedback.config.value.topicArns.includes(verified.TopicArn)) {
      return yield* Effect.fail(
        new SesFeedbackForbiddenError({ reason: "SNS TopicArn is not allowlisted." }),
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
  DatabaseService | SnsSubscriptionConfirmerService
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
  SesFeedbackMalformedError | DatabaseError,
  DatabaseService | IdGeneratorService
> {
  return Effect.gen(function* () {
    const event = yield* decodeSesEvent(envelope.Message);
    const recipients = recipientsForEvent(event);
    const now = yield* currentIso;
    const db = yield* Database;

    yield* db.transaction(
      Effect.gen(function* () {
        yield* insertNotification(rawBody, envelope, event.eventType, event.mail.messageId, now);

        for (const recipient of recipients) {
          yield* insertRecipientEvent(db, envelope, event, recipient, now);
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
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const now = yield* currentIso;
    yield* insertNotification(rawBody, envelope, eventType, sesMessageId, now);
  });
}

function insertNotification(
  rawBody: string,
  envelope: VerifiedSnsEnvelope,
  eventType: string | null,
  sesMessageId: string | null,
  now: string,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.run(
      "ses-feedback:notification:insert",
      `INSERT INTO ses_feedback_notifications (
         sns_message_id, sns_topic_arn, sns_type, event_type, ses_message_id, raw_json, received_at
       ) VALUES (
         $messageId, $topicArn, $type, $eventType, $sesMessageId, $rawJson, $receivedAt
       )
       ON CONFLICT(sns_message_id) DO NOTHING;`,
      {
        eventType,
        messageId: envelope.MessageId,
        rawJson: rawBody,
        receivedAt: now,
        sesMessageId,
        topicArn: envelope.TopicArn,
        type: envelope.Type,
      },
    );
  });
}

type RecipientFeedback = {
  readonly actionTaken: "ignored" | "recorded" | "suppressed";
  readonly bounceSubType: string | null;
  readonly bounceType: string | null;
  readonly complaintFeedbackType: string | null;
  readonly diagnosticCode: string | null;
  readonly email: string;
  readonly feedbackId: string | null;
  readonly shouldSuppressReason: "bounce" | "complaint" | null;
};

function recipientsForEvent(event: SesEvent): readonly RecipientFeedback[] {
  switch (event.eventType) {
    case "Bounce": {
      const bounce = event.bounce;
      if (!bounce) return [];
      const permanent = bounce.bounceType === "Permanent";
      return bounce.bouncedRecipients.map((recipient) => ({
        actionTaken: permanent ? "suppressed" : "recorded",
        bounceSubType: bounce.bounceSubType ?? null,
        bounceType: bounce.bounceType ?? null,
        complaintFeedbackType: null,
        diagnosticCode: recipient.diagnosticCode ?? null,
        email: recipient.emailAddress,
        feedbackId: bounce.feedbackId ?? null,
        shouldSuppressReason: permanent ? "bounce" : null,
      }));
    }
    case "Complaint": {
      const complaint = event.complaint;
      if (!complaint) return [];
      const notSpam = complaint.complaintFeedbackType === "not-spam";
      return complaint.complainedRecipients.map((recipient) => ({
        actionTaken: notSpam ? "recorded" : "suppressed",
        bounceSubType: null,
        bounceType: null,
        complaintFeedbackType: complaint.complaintFeedbackType ?? null,
        diagnosticCode: recipient.diagnosticCode ?? null,
        email: recipient.emailAddress,
        feedbackId: complaint.feedbackId ?? null,
        shouldSuppressReason: notSpam ? null : "complaint",
      }));
    }
    case "DeliveryDelay": {
      const delay = event.deliveryDelay;
      if (!delay) return [];
      return delay.delayedRecipients.map((recipient) => recordedRecipient(recipient));
    }
    case "Delivery":
      return (event.delivery?.recipients ?? []).map((email) => ({
        actionTaken: "recorded",
        bounceSubType: null,
        bounceType: null,
        complaintFeedbackType: null,
        diagnosticCode: null,
        email,
        feedbackId: null,
        shouldSuppressReason: null,
      }));
    case "Reject":
      return event.mail.destination.map((email) => ({
        actionTaken: "recorded",
        bounceSubType: null,
        bounceType: null,
        complaintFeedbackType: null,
        diagnosticCode: event.reject?.reason ?? null,
        email,
        feedbackId: null,
        shouldSuppressReason: null,
      }));
    default:
      return [];
  }
}

function recordedRecipient(recipient: SesRecipient): RecipientFeedback {
  return {
    actionTaken: "recorded",
    bounceSubType: null,
    bounceType: null,
    complaintFeedbackType: null,
    diagnosticCode: recipient.diagnosticCode ?? null,
    email: recipient.emailAddress,
    feedbackId: null,
    shouldSuppressReason: null,
  };
}

function insertRecipientEvent(
  db: DatabaseService,
  envelope: VerifiedSnsEnvelope,
  event: SesEvent,
  recipient: RecipientFeedback,
  now: string,
): Effect.Effect<void, DatabaseError, IdGeneratorService> {
  return Effect.gen(function* () {
    const normalizedEmail = recipient.email.trim().toLowerCase();
    if (normalizedEmail.length === 0) return;

    const resolved = yield* resolveDelivery(db, event, normalizedEmail);
    const idGenerator = yield* IdGenerator;
    const recipientId = yield* idGenerator.next;

    yield* db.run(
      "ses-feedback:recipient:insert",
      `INSERT INTO ses_feedback_recipients (
         id, sns_message_id, event_type, delivery_id, mailing_id, ses_message_id,
         recipient_email, feedback_id, bounce_type, bounce_sub_type, complaint_feedback_type,
         diagnostic_code, action_taken, created_at
       ) VALUES (
         $id, $snsMessageId, $eventType, $deliveryId, $mailingId, $sesMessageId,
         $recipientEmail, $feedbackId, $bounceType, $bounceSubType, $complaintFeedbackType,
         $diagnosticCode, $actionTaken, $createdAt
       )
       ON CONFLICT(sns_message_id, recipient_email, event_type) DO NOTHING;`,
      {
        actionTaken: recipient.actionTaken,
        bounceSubType: recipient.bounceSubType,
        bounceType: recipient.bounceType,
        complaintFeedbackType: recipient.complaintFeedbackType,
        createdAt: now,
        deliveryId: resolved?.deliveryId ?? null,
        diagnosticCode: recipient.diagnosticCode,
        eventType: event.eventType,
        feedbackId: recipient.feedbackId,
        id: recipientId,
        mailingId: resolved?.mailingId ?? null,
        recipientEmail: normalizedEmail,
        sesMessageId: event.mail.messageId,
        snsMessageId: envelope.MessageId,
      },
    );

    if (recipient.shouldSuppressReason) {
      const suppressionId = yield* idGenerator.next;
      yield* db.run(
        "ses-feedback:suppression:insert",
        `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
         VALUES ($id, $email, 'all', NULL, $reason, $createdAt)
         ON CONFLICT(email, scope) WHERE list_id IS NULL DO NOTHING;`,
        {
          createdAt: now,
          email: normalizedEmail,
          id: suppressionId,
          reason: recipient.shouldSuppressReason,
        },
      );
    }
  });
}

type ResolvedDelivery = { readonly deliveryId: string; readonly mailingId: string };

type DeliveryRow = { readonly id: string; readonly mailingId: string };

function resolveDelivery(
  db: DatabaseService,
  event: SesEvent,
  recipientEmail: string,
): Effect.Effect<ResolvedDelivery | null, DatabaseError> {
  return Effect.gen(function* () {
    const taggedDeliveryId = firstTagValue(event.mail.tags, "delivery_id");
    if (taggedDeliveryId) {
      const tagged = yield* db.get<DeliveryRow>(
        "ses-feedback:delivery:resolve-by-tag",
        `SELECT id, mailing_id AS mailingId
         FROM deliveries
         WHERE id = $deliveryId AND lower(email) = lower($email)
         LIMIT 1;`,
        { deliveryId: taggedDeliveryId, email: recipientEmail },
      );
      if (tagged) return { deliveryId: tagged.id, mailingId: tagged.mailingId };
    }

    const bySesMessageId = yield* db.get<DeliveryRow>(
      "ses-feedback:delivery:resolve-by-ses-message-id",
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
