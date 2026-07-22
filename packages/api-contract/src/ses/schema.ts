import { Schema } from "effect";

export const SesEventTypeSchema = Schema.Literals([
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
]);
export const SesReadinessStatusSchema = Schema.Literals(["error", "ok", "skipped", "warning"]);

export const SesEventSchema = Schema.Struct({
  actionTaken: Schema.String,
  bounceSubType: Schema.NullOr(Schema.String),
  bounceType: Schema.NullOr(Schema.String),
  complaintFeedbackType: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  deliveryDelayType: Schema.NullOr(Schema.String),
  deliveryId: Schema.NullOr(Schema.String),
  diagnosticCode: Schema.NullOr(Schema.String),
  eventType: SesEventTypeSchema,
  feedbackId: Schema.NullOr(Schema.String),
  id: Schema.String,
  ipAddress: Schema.NullOr(Schema.String),
  linkTags: Schema.NullOr(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  linkUrl: Schema.NullOr(Schema.String),
  mailingId: Schema.NullOr(Schema.String),
  notificationId: Schema.String,
  occurredAt: Schema.NullOr(Schema.String),
  recipientEmail: Schema.NullOr(Schema.String),
  rejectReason: Schema.NullOr(Schema.String),
  sesMessageId: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
});

export const SesEventsListResponseSchema = Schema.Struct({
  items: Schema.Array(SesEventSchema),
});
export const SesEventDetailResponseSchema = SesEventSchema;

export const SesWorkerRunSchema = Schema.Struct({
  claimed: Schema.Number,
  dead: Schema.Number,
  failed: Schema.Number,
  finishedAt: Schema.String,
  id: Schema.String,
  mode: Schema.String,
  released: Schema.Number,
  skippedStale: Schema.Number,
  succeeded: Schema.Number,
  workerId: Schema.String,
});

export const SesSummaryResponseSchema = Schema.Struct({
  counts: Schema.Struct({
    Bounce: Schema.Number,
    Click: Schema.Number,
    Complaint: Schema.Number,
    Delivery: Schema.Number,
    DeliveryDelay: Schema.Number,
    Open: Schema.Number,
    Reject: Schema.Number,
    "Rendering Failure": Schema.Number,
    Send: Schema.Number,
    Subscription: Schema.Number,
    Unknown: Schema.Number,
  }),
  latestEventAt: Schema.NullOr(Schema.String),
  latestNotificationAt: Schema.NullOr(Schema.String),
  recentIssues: Schema.Array(SesEventSchema),
  totals: Schema.Struct({
    bounce: Schema.Number,
    click: Schema.Number,
    complaint: Schema.Number,
    open: Schema.Number,
  }),
  worker: Schema.Struct({
    latestRun: Schema.NullOr(SesWorkerRunSchema),
  }),
});

export const SesReadinessCheckSchema = Schema.Struct({
  action: Schema.NullOr(Schema.String),
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  docs: Schema.Array(Schema.String),
  id: Schema.String,
  message: Schema.String,
  status: SesReadinessStatusSchema,
  title: Schema.String,
});

export const SesReadinessResponseSchema = Schema.Struct({
  checkedAt: Schema.String,
  checks: Schema.Array(SesReadinessCheckSchema),
  expectedWebhookUrl: Schema.NullOr(Schema.String),
  status: SesReadinessStatusSchema,
});

export const SesSetupGuideActionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("api"),
    text: Schema.String,
    url: Schema.String,
  }),
  Schema.Struct({
    command: Schema.String,
    kind: Schema.Literal("cli"),
  }),
  Schema.Struct({
    kind: Schema.Literal("console"),
    text: Schema.String,
  }),
]);

export const SesSetupGuideStepSchema = Schema.Struct({
  actions: Schema.Array(SesSetupGuideActionSchema),
  id: Schema.String,
  relatedChecks: Schema.Array(Schema.String),
  status: SesReadinessStatusSchema,
  title: Schema.String,
  why: Schema.String,
});

export const SesSetupGuideResponseSchema = Schema.Struct({
  docs: Schema.Array(Schema.String),
  status: SesReadinessStatusSchema,
  steps: Schema.Array(SesSetupGuideStepSchema),
  title: Schema.String,
});

export const SesSimulatorRunStatusSchema = Schema.Literals([
  "started",
  "sent",
  "validated",
  "failed",
  "timed_out",
  "ambiguous",
]);

export const SesSimulatorRunSchema = Schema.Struct({
  deliveryId: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  expectedEventType: Schema.NullOr(Schema.String),
  expectedSuppressionReason: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  mailingId: Schema.NullOr(Schema.String),
  mode: Schema.String,
  purpose: Schema.String,
  recipientEmail: Schema.String,
  scenario: Schema.String,
  startedAt: Schema.String,
  status: SesSimulatorRunStatusSchema,
  targetBaseUrl: Schema.NullOr(Schema.String),
});

export const SesSimulatorRunsListResponseSchema = Schema.Struct({
  items: Schema.Array(SesSimulatorRunSchema),
});
export const SesSimulatorRunDetailResponseSchema = SesSimulatorRunSchema;

export type SesEventType = typeof SesEventTypeSchema.Type;
export type SesReadinessStatus = typeof SesReadinessStatusSchema.Type;
export type SesEvent = typeof SesEventSchema.Type;
export type SesEventsListResponse = typeof SesEventsListResponseSchema.Type;
export type SesEventDetailResponse = typeof SesEventDetailResponseSchema.Type;
export type SesWorkerRun = typeof SesWorkerRunSchema.Type;
export type SesSummaryResponse = typeof SesSummaryResponseSchema.Type;
export type SesReadinessCheck = typeof SesReadinessCheckSchema.Type;
export type SesReadinessResponse = typeof SesReadinessResponseSchema.Type;
export type SesSetupGuideAction = typeof SesSetupGuideActionSchema.Type;
export type SesSetupGuideStep = typeof SesSetupGuideStepSchema.Type;
export type SesSetupGuideResponse = typeof SesSetupGuideResponseSchema.Type;
export type SesSimulatorRunStatus = typeof SesSimulatorRunStatusSchema.Type;
export type SesSimulatorRun = typeof SesSimulatorRunSchema.Type;
export type SesSimulatorRunsListResponse = typeof SesSimulatorRunsListResponseSchema.Type;
export type SesSimulatorRunDetailResponse = typeof SesSimulatorRunDetailResponseSchema.Type;
