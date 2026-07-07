// Queue row shapes. Kinds and states are also CHECK-constrained in SQLite
// (0001_initial_schema.sql), so a decode failure on a returned row is a true
// defect, not an expected error.
import { Schema } from "effect";

export const JobKindValues = ["send_delivery"] as const;
export const JobKind = Schema.Literals(JobKindValues);
export type JobKind = typeof JobKind.Type;

// Mirrors the jobs.state SQLite CHECK constraint in 0001_initial_schema.sql.
export const JobStateValues = [
  "queued",
  "leased",
  "succeeded",
  "failed",
  "dead",
  "cancelled",
] as const;
export const JobState = Schema.Literals(JobStateValues);
export type JobState = typeof JobState.Type;

// Matches the aliased RETURNING column list in jobs.ts verbatim.
export const QueueJob = Schema.Struct({
  attempts: Schema.Number,
  createdAt: Schema.String,
  id: Schema.String,
  kind: JobKind,
  lastError: Schema.NullOr(Schema.String),
  lockedBy: Schema.NullOr(Schema.String),
  lockedUntil: Schema.NullOr(Schema.String),
  maxAttempts: Schema.Number,
  refId: Schema.String,
  runAt: Schema.String,
  state: JobState,
  updatedAt: Schema.String,
});
export type QueueJob = typeof QueueJob.Type;
