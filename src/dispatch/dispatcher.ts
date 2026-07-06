import { DurableObject } from "cloudflare:workers";

import type { AppBindings } from "../bindings.ts";
import { getNextQueuedRunAt, type JobKind } from "../queue/jobs.ts";
import { runOnce } from "../queue/runner.ts";
import { createProcessorRegistry, registeredKinds } from "./processors.ts";

const pokeAlarmDelayMs = 1000;
const alarmBatchSize = 10;

// Single global dispatcher: processes registered D1 job kinds in bounded
// slices driven by alarms, persisting all durable state in D1. It will later
// also hold the global SES rate limiter.
export class Dispatcher extends DurableObject<AppBindings> {
  async poke(): Promise<void> {
    await this.ensureAlarm(registeredKinds(createProcessorRegistry(this.env.DB)));
  }

  async alarm(): Promise<void> {
    const db = this.env.DB;
    const registry = createProcessorRegistry(db);
    const kinds = registeredKinds(registry);
    if (kinds.length === 0) return;

    await runOnce({
      batchSize: alarmBatchSize,
      db,
      kinds,
      processJob: async (job) => {
        const processor = registry[job.kind];
        if (!processor) {
          throw new Error(`No processor registered for job kind '${job.kind}'.`);
        }
        await processor(job);
      },
      workerId: `dispatcher:${crypto.randomUUID()}`,
    });

    await this.ensureAlarm(kinds);
  }

  private async ensureAlarm(kinds: JobKind[]): Promise<void> {
    if (kinds.length === 0) return;

    const nextRunAt = await getNextQueuedRunAt(this.env.DB, kinds);
    if (nextRunAt === null) return;

    const targetTime = Math.max(Date.now() + pokeAlarmDelayMs, new Date(nextRunAt).getTime());
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || targetTime < currentAlarm) {
      await this.ctx.storage.setAlarm(targetTime);
    }
  }
}
