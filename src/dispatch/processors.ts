import { createExpandMailingProcessor } from "../mailings/expand-mailing.ts";
import type { JobKind } from "../queue/jobs.ts";
import type { JobProcessor } from "../queue/runner.ts";

export type ProcessorRegistry = Partial<Record<JobKind, JobProcessor>>;

// The dispatcher only ever claims kinds present in this registry. Do NOT
// register 'send_delivery' until a real SES sender exists — claiming it would
// mark queued emails as processed without sending anything.
export function createProcessorRegistry(db: D1Database): ProcessorRegistry {
  return {
    expand_mailing: createExpandMailingProcessor(db),
  };
}

export function registeredKinds(registry: ProcessorRegistry): JobKind[] {
  return Object.keys(registry) as JobKind[];
}
