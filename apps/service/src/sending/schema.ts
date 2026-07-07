import { Data } from "effect";

import type { MailingPurpose } from "../mailings/schema.ts";
import type { QueueJob } from "../queue/schema.ts";

export type DeliveryStatus =
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "suppressed"
  | "cancelled";

export type DeliveryContext = {
  readonly delivery: {
    readonly contactId: string | null;
    readonly email: string;
    readonly id: string;
    readonly mailingId: string;
    readonly status: DeliveryStatus;
    readonly varsJson: string | null;
  };
  readonly job: QueueJob;
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
};
