import { setTimeout as sleep } from "node:timers/promises";
import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime } from "effect";

import { deploymentConfig, sendingConfigFromDeployment } from "../config.ts";
import {
  assertMigrationsUpToDate,
  describeStartupMigrationFailure,
} from "../db/migration-check.ts";
import { JsonLoggerLive } from "../observability/effect-logger.ts";
import { Database } from "../services/database.ts";
import { DatabaseBunLive } from "../services/database-bun.ts";
import { EmailSendingConfigLive } from "../services/email-transport.ts";
import { EmailTransportSesLive } from "../services/email-transport-ses.ts";
import { IdGeneratorLive } from "../services/ids.ts";
import { UnsubscribeConfigLive } from "../unsubscribe/config.ts";
import { runSendWorkerOnce } from "../queue/runner.ts";
import { runSendWorkerLoop } from "./worker-loop.ts";

const mode = process.argv[2];
if (mode !== "once" && mode !== "loop") {
  console.error("Usage: bun src/sending/worker-main.ts once|loop");
  process.exit(1);
}

const configProvider = ConfigProvider.fromEnv();
const loaded = await loadConfig(
  "send worker",
  Effect.flatMap(deploymentConfig, (deployment) =>
    Effect.map(sendingConfigFromDeployment(deployment), (sending) => ({ deployment, sending })),
  ),
);
const service = loaded.deployment.service;
const sending = loaded.sending;
const unsubscribe = loaded.deployment.unsubscribe;
const workerId = process.env.NUSEND_WORKER_ID?.trim() || `send-worker-${crypto.randomUUID()}`;

const sendingConfigLayer = EmailSendingConfigLive(sending);
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    DatabaseBunLive(service.databasePath),
    IdGeneratorLive,
    sendingConfigLayer,
    UnsubscribeConfigLive(unsubscribe),
    EmailTransportSesLive.pipe(Layer.provide(sendingConfigLayer)),
    JsonLoggerLive,
  ),
);

try {
  const alive = await runtime.runPromise(Effect.flatMap(Database, (db) => db.ping));
  if (!alive) throw new Error("database ping failed");
} catch {
  await runtime.runPromise(
    Effect.logError("send worker startup failed", { event: "send_worker_startup_failed" }),
  );
  console.error("Failed to start send worker. See structured logs for safe diagnostics.");
  await runtime.dispose();
  process.exit(1);
}

// Refuse to run against a stale/empty schema (same guard as the service).
const migrationCheck = await runtime.runPromiseExit(assertMigrationsUpToDate());
if (Exit.isFailure(migrationCheck)) {
  console.error(
    `Failed to start send worker: ${describeStartupMigrationFailure(migrationCheck.cause)}`,
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
        mode: "once",
        workerId,
      }),
    );
    console.log(JSON.stringify(result));
  } else {
    await runLoop();
  }
} catch {
  await runtime.runPromise(Effect.logError("send worker failed", { event: "send_worker_failed" }));
  console.error("Send worker failed. See structured logs for safe diagnostics.");
  await runtime.dispose();
  process.exit(1);
}

await runtime.dispose();

async function runLoop(): Promise<void> {
  await runSendWorkerLoop({
    isShuttingDown: () => shuttingDown,
    onError: (event) => runtime.runPromise(Effect.logWarning("send worker cycle failed", event)),
    onResult: (result) => console.log(JSON.stringify(result)),
    pollIntervalMs: sending.workerPollMs,
    runOnce: () =>
      runtime.runPromise(
        runSendWorkerOnce({
          batchSize: sending.workerBatchSize,
          leaseSeconds: sending.workerLeaseSeconds,
          mode: "loop",
          workerId,
        }),
      ),
    sleep: (ms) => sleep(ms),
  });
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
