import { Effect, Schema } from "effect";

import { SesOperationsMalformedError } from "./errors.ts";

const SesRecipient = Schema.Struct({
  action: Schema.optional(Schema.String),
  diagnosticCode: Schema.optional(Schema.String),
  emailAddress: Schema.String,
  status: Schema.optional(Schema.String),
});

const SesEventSchema = Schema.fromJsonString(
  Schema.Struct({
    bounce: Schema.optional(
      Schema.Struct({
        bounceSubType: Schema.optional(Schema.String),
        bounceType: Schema.optional(Schema.String),
        bouncedRecipients: Schema.Array(SesRecipient),
        feedbackId: Schema.optional(Schema.String),
        timestamp: Schema.optional(Schema.String),
      }),
    ),
    click: Schema.optional(
      Schema.Struct({
        ipAddress: Schema.optional(Schema.String),
        link: Schema.optional(Schema.String),
        linkTags: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
        timestamp: Schema.optional(Schema.String),
        userAgent: Schema.optional(Schema.String),
      }),
    ),
    complaint: Schema.optional(
      Schema.Struct({
        complainedRecipients: Schema.Array(SesRecipient),
        complaintFeedbackType: Schema.optional(Schema.String),
        feedbackId: Schema.optional(Schema.String),
        timestamp: Schema.optional(Schema.String),
      }),
    ),
    delivery: Schema.optional(
      Schema.Struct({
        recipients: Schema.Array(Schema.String),
        timestamp: Schema.optional(Schema.String),
      }),
    ),
    deliveryDelay: Schema.optional(
      Schema.Struct({
        delayedRecipients: Schema.Array(SesRecipient),
        delayType: Schema.optional(Schema.String),
        timestamp: Schema.optional(Schema.String),
      }),
    ),
    eventType: Schema.String,
    mail: Schema.Struct({
      destination: Schema.Array(Schema.String),
      messageId: Schema.String,
      tags: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
      timestamp: Schema.optional(Schema.String),
    }),
    open: Schema.optional(
      Schema.Struct({
        ipAddress: Schema.optional(Schema.String),
        timestamp: Schema.optional(Schema.String),
        userAgent: Schema.optional(Schema.String),
      }),
    ),
    reject: Schema.optional(
      Schema.Struct({
        reason: Schema.optional(Schema.String),
      }),
    ),
    renderingFailure: Schema.optional(
      Schema.Struct({
        errorMessage: Schema.optional(Schema.String),
        templateName: Schema.optional(Schema.String),
      }),
    ),
    subscription: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);

export const SesEventTypeValues = [
  "Send",
  "Rendering Failure",
  "Reject",
  "Delivery",
  "DeliveryDelay",
  "Bounce",
  "Complaint",
  "Subscription",
  "Open",
  "Click",
  "Unknown",
] as const;

export type SesEventType = (typeof SesEventTypeValues)[number];
export type SesEvent = Omit<typeof SesEventSchema.Type, "eventType"> & {
  readonly eventType: SesEventType;
};
export type SesRecipient = typeof SesRecipient.Type;

export function normalizeSesEventType(value: string): SesEventType {
  return (SesEventTypeValues as readonly string[]).includes(value)
    ? (value as SesEventType)
    : "Unknown";
}

export function decodeSesEvent(
  message: string,
): Effect.Effect<SesEvent, SesOperationsMalformedError> {
  return Schema.decodeUnknownEffect(SesEventSchema)(message, { errors: "all" }).pipe(
    Effect.map((event) => ({ ...event, eventType: normalizeSesEventType(event.eventType) })),
    Effect.mapError(
      () => new SesOperationsMalformedError({ reason: "SES event has an invalid shape." }),
    ),
  );
}
