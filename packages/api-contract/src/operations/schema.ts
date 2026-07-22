import { Schema } from "effect";

export const DeliveryStatusSchema = Schema.Literals([
  "queued",
  "sending",
  "sent",
  "failed",
  "suppressed",
  "ambiguous",
]);
export const JobStateSchema = Schema.Literals(["queued", "leased", "succeeded", "dead"]);
export const SendAttemptStatusSchema = Schema.Literals([
  "started",
  "succeeded",
  "failed",
  "ambiguous",
]);
export const OperationsMailingPurposeSchema = Schema.Literals(["transactional", "marketing"]);
export const OperationsMailingStateSchema = Schema.Literals(["scheduled", "sending", "completed"]);

export const OperationsRecentIssueSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["job", "delivery", "send_attempt"]),
  message: Schema.NullOr(Schema.String),
  relatedId: Schema.NullOr(Schema.String),
  status: Schema.String,
  updatedAt: Schema.String,
});

export const OperationsSummaryResponseSchema = Schema.Struct({
  deliveries: Schema.Struct({
    ambiguous: Schema.Number,
    failed: Schema.Number,
    queued: Schema.Number,
    sending: Schema.Number,
    sent: Schema.Number,
    suppressed: Schema.Number,
  }),
  jobs: Schema.Struct({
    dead: Schema.Number,
    leased: Schema.Number,
    queued: Schema.Number,
    succeeded: Schema.Number,
  }),
  recentIssues: Schema.Array(OperationsRecentIssueSchema),
  sendAttempts: Schema.Struct({
    ambiguous: Schema.Number,
    failed: Schema.Number,
    started: Schema.Number,
    succeeded: Schema.Number,
  }),
});

export const DeliveryListJobSchema = Schema.Struct({
  attempts: Schema.Number,
  id: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  lockedUntil: Schema.NullOr(Schema.String),
  maxAttempts: Schema.Number,
  runAt: Schema.String,
  state: JobStateSchema,
});

export const DeliveryListAttemptSchema = Schema.Struct({
  attemptNo: Schema.Number,
  errorMessage: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  sesMessageId: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  status: SendAttemptStatusSchema,
});

export const DeliveryListItemSchema = Schema.Struct({
  createdAt: Schema.String,
  email: Schema.String,
  id: Schema.String,
  job: Schema.NullOr(DeliveryListJobSchema),
  lastError: Schema.NullOr(Schema.String),
  latestAttempt: Schema.NullOr(DeliveryListAttemptSchema),
  mailingId: Schema.String,
  mailingPurpose: OperationsMailingPurposeSchema,
  sesMessageId: Schema.NullOr(Schema.String),
  status: DeliveryStatusSchema,
  updatedAt: Schema.String,
});

export const DeliveriesListResponseSchema = Schema.Struct({
  items: Schema.Array(DeliveryListItemSchema),
});

export const DeliverySchema = Schema.Struct({
  contactId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  email: Schema.String,
  id: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  mailingId: Schema.String,
  sesMessageId: Schema.NullOr(Schema.String),
  status: DeliveryStatusSchema,
  updatedAt: Schema.String,
});

export const DeliveryJobSchema = Schema.Struct({
  attempts: Schema.Number,
  createdAt: Schema.String,
  id: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  lockedBy: Schema.NullOr(Schema.String),
  lockedUntil: Schema.NullOr(Schema.String),
  maxAttempts: Schema.Number,
  runAt: Schema.String,
  state: JobStateSchema,
  updatedAt: Schema.String,
});

export const DeliveryAttemptSchema = Schema.Struct({
  attemptNo: Schema.Number,
  errorMessage: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  sesMessageId: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  status: SendAttemptStatusSchema,
});

export const DeliveryMailingSchema = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  purpose: OperationsMailingPurposeSchema,
  scheduledAt: Schema.NullOr(Schema.String),
  state: OperationsMailingStateSchema,
  subject: Schema.String,
  updatedAt: Schema.String,
});

export const DeliveryDetailResponseSchema = Schema.Struct({
  attempts: Schema.Array(DeliveryAttemptSchema),
  delivery: DeliverySchema,
  job: Schema.NullOr(DeliveryJobSchema),
  mailing: DeliveryMailingSchema,
});

export type DeliveryStatus = typeof DeliveryStatusSchema.Type;
export type JobState = typeof JobStateSchema.Type;
export type SendAttemptStatus = typeof SendAttemptStatusSchema.Type;
export type OperationsMailingPurpose = typeof OperationsMailingPurposeSchema.Type;
export type OperationsMailingState = typeof OperationsMailingStateSchema.Type;
export type OperationsRecentIssue = typeof OperationsRecentIssueSchema.Type;
export type OperationsSummaryResponse = typeof OperationsSummaryResponseSchema.Type;
export type DeliveryListJob = typeof DeliveryListJobSchema.Type;
export type DeliveryListAttempt = typeof DeliveryListAttemptSchema.Type;
export type DeliveryListItem = typeof DeliveryListItemSchema.Type;
export type DeliveriesListResponse = typeof DeliveriesListResponseSchema.Type;
export type Delivery = typeof DeliverySchema.Type;
export type DeliveryJob = typeof DeliveryJobSchema.Type;
export type DeliveryAttempt = typeof DeliveryAttemptSchema.Type;
export type DeliveryMailing = typeof DeliveryMailingSchema.Type;
export type DeliveryDetailResponse = typeof DeliveryDetailResponseSchema.Type;
