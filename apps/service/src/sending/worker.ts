import { Effect } from "effect";

import type { DatabaseError } from "../errors.ts";
import { runOnce, type RunOnceResult } from "../queue/runner.ts";
import type { DatabaseService } from "../services/database.ts";
import type {
  EmailSendingConfigService,
  EmailTransportService,
} from "../services/email-transport.ts";
import type { IdGeneratorService } from "../services/ids.ts";
import { processSendDeliveryJob } from "./process-delivery.ts";
export type SendWorkerOnceOptions = {
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly workerId: string;
};

export function runSendWorkerOnce(
  options: SendWorkerOnceOptions,
): Effect.Effect<
  RunOnceResult,
  DatabaseError,
  DatabaseService | EmailSendingConfigService | EmailTransportService | IdGeneratorService
> {
  return runOnce<
    DatabaseService | EmailSendingConfigService | EmailTransportService | IdGeneratorService
  >({
    batchSize: options.batchSize,
    kinds: ["send_delivery"],
    leaseSeconds: options.leaseSeconds,
    processJob: processSendDeliveryJob,
    workerId: options.workerId,
  });
}
