import { Data } from "effect";

import type { MailingPurpose } from "../mailings/schema.ts";
import type { SendDeliveryJob } from "../queue/schema.ts";

// Mirrors the deliveries.status CHECK constraint in the current baseline.
export const DeliveryStatusValues = [
  "queued",
  "sending",
  "sent",
  "failed",
  "suppressed",
  "ambiguous",
] as const;
export type DeliveryStatus = (typeof DeliveryStatusValues)[number];

// Mirrors the send_attempts.status SQLite CHECK constraint in 0001_initial_schema.sql.
export const SendAttemptStatusValues = ["started", "succeeded", "failed", "ambiguous"] as const;
export type SendAttemptStatus = (typeof SendAttemptStatusValues)[number];

export type DeliveryContext = {
  readonly delivery: {
    readonly contactId: string | null;
    readonly email: string;
    readonly id: string;
    readonly mailingId: string;
    readonly status: DeliveryStatus;
    readonly varsJson: string | null;
  };
  readonly job: SendDeliveryJob;
  readonly mailing: {
    readonly html: string;
    readonly id: string;
    readonly listId: string | null;
    readonly purpose: MailingPurpose;
    readonly subject: string;
    readonly text: string | null;
  };
};

export type StartedAttempt = {
  readonly attemptId: string;
  readonly attemptNo: number;
};

export class SendPreparationError extends Data.TaggedError("SendPreparationError")<{
  readonly message: string;
}> {}

export class SendProcessorError extends Data.TaggedError("SendProcessorError")<{
  readonly message: string;
}> {}

export type RenderedEmail = {
  readonly html: string;
  readonly subject: string;
  readonly text: string | null;
  readonly unsubscribeUrl: string | null;
};
