import { Effect, Schema } from "effect";

import { SesFeedbackMalformedError } from "./errors.ts";

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
      }),
    ),
    complaint: Schema.optional(
      Schema.Struct({
        complainedRecipients: Schema.Array(SesRecipient),
        complaintFeedbackType: Schema.optional(Schema.String),
        feedbackId: Schema.optional(Schema.String),
      }),
    ),
    delivery: Schema.optional(
      Schema.Struct({
        recipients: Schema.Array(Schema.String),
      }),
    ),
    deliveryDelay: Schema.optional(
      Schema.Struct({
        delayedRecipients: Schema.Array(SesRecipient),
      }),
    ),
    eventType: Schema.String,
    mail: Schema.Struct({
      destination: Schema.Array(Schema.String),
      messageId: Schema.String,
      tags: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    }),
    reject: Schema.optional(
      Schema.Struct({
        reason: Schema.optional(Schema.String),
      }),
    ),
  }),
);

export type SesEvent = typeof SesEventSchema.Type;
export type SesRecipient = typeof SesRecipient.Type;

export function decodeSesEvent(
  message: string,
): Effect.Effect<SesEvent, SesFeedbackMalformedError> {
  return Schema.decodeUnknownEffect(SesEventSchema)(message, { errors: "all" }).pipe(
    Effect.mapError(
      () => new SesFeedbackMalformedError({ reason: "SES event has an invalid shape." }),
    ),
  );
}
