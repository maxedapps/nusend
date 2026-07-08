// Send-delivery queue row shapes. States are also CHECK-constrained in SQLite
// migrations, so a decode failure on a returned row is a true defect.
import { Schema } from "effect";

// Mirrors the jobs.state SQLite CHECK constraint after 0002.
export const JobStateValues = ["queued", "leased", "succeeded", "dead"] as const;
export const JobState = Schema.Literals(JobStateValues);
export type JobState = typeof JobState.Type;

// Matches the aliased RETURNING column list in jobs.ts verbatim.
export const SendDeliveryJob = Schema.Struct({
  attempts: Schema.Number,
  createdAt: Schema.String,
  deliveryId: Schema.String,
  id: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  lockedBy: Schema.NullOr(Schema.String),
  lockedUntil: Schema.NullOr(Schema.String),
  maxAttempts: Schema.Number,
  runAt: Schema.String,
  state: JobState,
  updatedAt: Schema.String,
});
export type SendDeliveryJob = typeof SendDeliveryJob.Type;
