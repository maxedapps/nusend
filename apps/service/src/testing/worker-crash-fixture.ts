import { existsSync, writeFileSync } from "node:fs";
import { Effect, Layer, ManagedRuntime, Option } from "effect";

import { runSendWorkerOnce } from "../queue/runner.ts";
import { DatabaseBunLive } from "../services/database-bun.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { EmailTransport, type EmailTransportService } from "../services/email-transport.ts";
import { IdGenerator } from "../services/ids.ts";
import { recordSendSuccess, recordStaleSendingAsAmbiguous } from "../sending/attempts.ts";
import { UnsubscribeConfigLive } from "../unsubscribe/config.ts";
import { fakeSendingConfigLayer } from "./email-transport.ts";

const mode = process.argv[2];
const databasePath = requiredEnv("NUSEND_DB_PATH");

switch (mode) {
  case "worker-block":
    await runBlockingWorker();
    break;
  case "worker-once":
    await runRestartWorker();
    break;
  case "late-success":
    await runDatabaseOnly(
      recordSendSuccess({
        attemptId: requiredEnv("NUSEND_ATTEMPT_ID"),
        deliveryId: requiredEnv("NUSEND_DELIVERY_ID"),
        messageId: requiredEnv("NUSEND_MESSAGE_ID"),
      }),
    );
    break;
  case "race-success":
    await runRace("success");
    break;
  case "race-stale":
    await runRace("stale");
    break;
  default:
    throw new Error(`Unknown worker crash fixture mode: ${mode ?? "missing"}`);
}

async function runBlockingWorker(): Promise<void> {
  const marker = requiredEnv("NUSEND_DISPATCH_MARKER");
  const transport = Layer.succeed(EmailTransport)({
    send: () =>
      Effect.sync(() => writeFileSync(marker, "dispatched\n", { flag: "wx" })).pipe(
        Effect.andThen(Effect.never),
      ),
  });
  await runWorker(transport);
}

async function runRestartWorker(): Promise<void> {
  const marker = requiredEnv("NUSEND_DISPATCH_MARKER");
  const transport = Layer.succeed(EmailTransport)({
    send: () =>
      Effect.sync(() => writeFileSync(marker, "unexpected-second-dispatch\n", { flag: "wx" })).pipe(
        Effect.as({ messageId: "unexpected-second-message" }),
      ),
  });
  const result = await runWorker(transport);
  writeResult(result);
}

async function runWorker(transport: Layer.Layer<EmailTransportService>): Promise<unknown> {
  const dbLayer = DatabaseBunLive(databasePath);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      dbLayer,
      Layer.succeed(IdGenerator)({ next: Effect.succeed("attempt_crash") }),
      transport,
      fakeSendingConfigLayer(),
      UnsubscribeConfigLive(Option.none()),
    ),
  );
  try {
    return await runtime.runPromise(
      runSendWorkerOnce({ batchSize: 1, leaseSeconds: 1, workerId: `fixture-${mode}` }),
    );
  } finally {
    await runtime.dispose();
  }
}

async function runDatabaseOnly<A>(effect: Effect.Effect<A, unknown, DatabaseService>): Promise<A> {
  const runtime = ManagedRuntime.make(DatabaseBunLive(databasePath));
  try {
    const result = await runtime.runPromise(effect);
    writeResult(result);
    return result;
  } finally {
    await runtime.dispose();
  }
}

async function runRace(kind: "stale" | "success"): Promise<void> {
  const baseLayer = DatabaseBunLive(databasePath);
  const attempted = requiredEnv("NUSEND_RACE_ATTEMPTED");
  const acquired = requiredEnv("NUSEND_RACE_ACQUIRED");
  const release = requiredEnv("NUSEND_RACE_RELEASE");
  const hold = process.env.NUSEND_RACE_HOLD === "1";
  const wrappedLayer = Layer.effect(
    Database,
    Effect.map(Database, (base) => wrapTransaction(base, { acquired, attempted, hold, release })),
  ).pipe(Layer.provide(baseLayer));
  const runtime = ManagedRuntime.make(wrappedLayer);

  try {
    const effect =
      kind === "success"
        ? recordSendSuccess({
            attemptId: "attempt_race",
            deliveryId: "delivery_race",
            messageId: "race-message",
          })
        : recordStaleSendingAsAmbiguous({
            deliveryId: "delivery_race",
            errorMessage: "stale race marker",
          });
    const result = await runtime.runPromise(effect);
    writeResult(result);
  } finally {
    await runtime.dispose();
  }
}

function wrapTransaction(
  base: DatabaseService,
  barrier: {
    acquired: string;
    attempted: string;
    hold: boolean;
    release: string;
  },
): DatabaseService {
  return {
    ...base,
    transaction: (work) =>
      Effect.sync(() => writeFileSync(barrier.attempted, "attempted\n", { flag: "wx" })).pipe(
        Effect.andThen(
          base.transaction(
            Effect.sync(() => {
              writeFileSync(barrier.acquired, "acquired\n", { flag: "wx" });
              if (barrier.hold) waitForRelease(barrier.release);
            }).pipe(Effect.andThen(work)),
          ),
        ),
      ),
  };
}

function waitForRelease(path: string): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) Atomics.wait(sleeper, 0, 0, 10);
}

function writeResult(result: unknown): void {
  const path = process.env.NUSEND_RESULT_PATH;
  if (path) writeFileSync(path, `${JSON.stringify(result)}\n`, { flag: "wx" });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
