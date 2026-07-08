import { Effect, Schema } from "effect";

import { SesFeedbackMalformedError } from "./errors.ts";

export const SnsMessageType = Schema.Literals([
  "Notification",
  "SubscriptionConfirmation",
  "UnsubscribeConfirmation",
]);

export type SnsMessageType = typeof SnsMessageType.Type;

const SnsEnvelopeSchema = Schema.Struct({
  Message: Schema.String,
  MessageId: Schema.String,
  Signature: Schema.String,
  SignatureVersion: Schema.String,
  SigningCertURL: Schema.String,
  Subject: Schema.optional(Schema.String),
  SubscribeURL: Schema.optional(Schema.String),
  Timestamp: Schema.String,
  Token: Schema.optional(Schema.String),
  TopicArn: Schema.String,
  Type: SnsMessageType,
  UnsubscribeURL: Schema.optional(Schema.String),
});

const SnsEnvelopeJsonSchema = Schema.fromJsonString(SnsEnvelopeSchema);

export type SnsEnvelope = typeof SnsEnvelopeSchema.Type;
export type VerifiedSnsEnvelope = SnsEnvelope;

export function decodeUnverifiedSnsEnvelopeString(
  input: string,
): Effect.Effect<SnsEnvelope, SesFeedbackMalformedError> {
  return Schema.decodeUnknownEffect(SnsEnvelopeJsonSchema)(input, { errors: "all" }).pipe(
    Effect.mapError(
      () => new SesFeedbackMalformedError({ reason: "SNS envelope has an invalid shape." }),
    ),
  );
}

export function decodeSnsEnvelope(
  input: unknown,
): Effect.Effect<SnsEnvelope, SesFeedbackMalformedError> {
  return Schema.decodeUnknownEffect(SnsEnvelopeSchema)(input, { errors: "all" }).pipe(
    Effect.mapError(
      () => new SesFeedbackMalformedError({ reason: "SNS envelope has an invalid shape." }),
    ),
  );
}
