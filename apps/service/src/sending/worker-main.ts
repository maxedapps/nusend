import { setTimeout as sleep } from "node:timers/promises";
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";

import { sendingConfig, serviceConfig } from "../config.ts";
import { Database } from "../services/database.ts";
import { DatabaseBunLive } from "../services/database-bun.ts";
import { EmailSendingConfigLive } from "../services/email-transport.ts";
import { EmailTransportSesLive } from "../services/email-transport-ses.ts";
import { IdGeneratorLive } from "../services/ids.ts";
import { runSendWorkerOnce } from "./worker.ts";

const mode = process.argv[2];
if (mode !== "once" && mode !== "loop") {
  console.error("Usage: bun src/sending/worker-main.ts once|loop");
  process.exit(1);
}

const configProvider = ConfigProvider.fromEnv();
const service = await loadConfig("service", serviceConfig);
const sending = await loadConfig("sending", sendingConfig);
const workerId = process.env.NUSEND_WORKER_ID?.trim() || `send-worker-${crypto.randomUUID()}`;
const pollIntervalMs = Number(process.env.NUSEND_SEND_WORKER_POLL_MS?.trim() || "5000");

if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
  console.error("Invalid configuration: NUSEND_SEND_WORKER_POLL_MS must be a positive integer.");
  process.exit(1);
}

const sendingConfigLayer = EmailSendingConfigLive(sending);
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    DatabaseBunLive(service.databasePath),
    IdGeneratorLive,
    sendingConfigLayer,
    EmailTransportSesLive.pipe(Layer.provide(sendingConfigLayer)),
  ),
);

try {
  const alive = await runtime.runPromise(Effect.flatMap(Database, (db) => db.ping));
  if (!alive) throw new Error("database ping failed");
} catch (error) {
  console.error(
    `Failed to start send worker: ${error instanceof Error ? error.message : String(error)}`,
  );
  await runtime.dispose();
  process.exit(1);
}

let shuttingDown = false;
process.on("SIGINT", () => {
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

try {
  if (mode === "once") {
    const result = await runtime.runPromise(
      runSendWorkerOnce({
        batchSize: sending.workerBatchSize,
        leaseSeconds: sending.workerLeaseSeconds,
        workerId,
      }),
    );
    console.log(JSON.stringify(result));
  } else {
    await runLoop();
  }
} catch (error) {
  console.error(`Send worker failed: ${error instanceof Error ? error.message : String(error)}`);
  await runtime.dispose();
  process.exit(1);
}

await runtime.dispose();

async function runLoop(): Promise<void> {
  if (shuttingDown) return;

  const result = await runtime.runPromise(
    runSendWorkerOnce({
      batchSize: sending.workerBatchSize,
      leaseSeconds: sending.workerLeaseSeconds,
      workerId,
    }),
  );
  console.log(JSON.stringify(result));
  if (result.claimed === 0) await sleep(pollIntervalMs);

  return runLoop();
}

async function loadConfig<A>(label: string, effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configProvider)),
  ).catch((error: unknown) => {
    console.error(
      `Invalid ${label} configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
