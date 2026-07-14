import { existsSync, writeFileSync } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";

import { createMailing } from "../mailings/create-mailing.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { DatabaseBunLive } from "../services/database-bun.ts";
import { IdGeneratorLive, type IdGeneratorService } from "../services/ids.ts";
import { deleteList } from "../lists/write.ts";
import { deleteManualSuppression, upsertAutomatedSuppression } from "../suppressions/write.ts";

const [
  databasePath,
  readyPath,
  startPath,
  attemptedPath,
  acquiredPath,
  releasePath,
  resultPath,
  operation,
] = process.argv.slice(2);
if (
  !databasePath ||
  !readyPath ||
  !startPath ||
  !attemptedPath ||
  !acquiredPath ||
  !releasePath ||
  !resultPath ||
  !operation
) {
  throw new Error("Missing race fixture arguments.");
}

const rawDatabaseLayer = DatabaseBunLive(databasePath);
const coordinatedDatabaseLayer = Layer.effect(
  Database,
  Effect.map(Database, (database) =>
    coordinateTransactions(database, { acquiredPath, attemptedPath, releasePath }),
  ),
).pipe(Layer.provide(rawDatabaseLayer));
const runtime = ManagedRuntime.make(Layer.mergeAll(coordinatedDatabaseLayer, IdGeneratorLive));

try {
  await runtime.runPromise(Effect.flatMap(Database, (db) => db.ping));
  writeFileSync(readyPath, "ready");
  await waitForFile(startPath, "start");
  const result = await runtime.runPromise(
    operationEffect(operation).pipe(
      Effect.match({
        onFailure: (error) => ({
          ok: false as const,
          tag: Reflect.get(error, "_tag") as string,
        }),
        onSuccess: () => ({ ok: true as const }),
      }),
    ),
  );
  writeFileSync(resultPath, JSON.stringify(result));
} finally {
  await runtime.dispose();
}

function coordinateTransactions(
  database: DatabaseService,
  barriers: {
    readonly acquiredPath: string;
    readonly attemptedPath: string;
    readonly releasePath: string;
  },
): DatabaseService {
  const transaction: DatabaseService["transaction"] = (work) =>
    Effect.sync(() => writeFileSync(barriers.attemptedPath, "attempted")).pipe(
      Effect.andThen(
        database.transaction(
          Effect.gen(function* () {
            // This executes only after the delegated production driver has completed
            // BEGIN IMMEDIATE, so the marker proves this process owns the write lock.
            yield* Effect.sync(() => writeFileSync(barriers.acquiredPath, "acquired"));
            // Test-only suspension while holding the write transaction: production
            // functions remain unchanged and run only after the parent releases it.
            yield* Effect.promise(() => waitForFile(barriers.releasePath, "transaction release"));
            return yield* work;
          }),
        ),
      ),
    );

  return { ...database, transaction };
}

function operationEffect(
  operationName: string,
): Effect.Effect<unknown, { readonly _tag: string }, DatabaseService | IdGeneratorService> {
  switch (operationName) {
    case "promote-suppression":
      // Promotion is normally one statement. The outer test-only transaction lets
      // the same real upsert participate in deterministic write-lock coordination.
      return Effect.flatMap(Database, (db) =>
        db.transaction(
          upsertAutomatedSuppression({
            createdAt: "2026-07-04T00:00:00.000Z",
            email: "Race@Example.com",
            id: "supp_automated",
            reason: "bounce",
            scope: "all",
          }),
        ),
      );
    case "delete-suppression":
      return deleteManualSuppression("supp_manual");
    case "create-mailing":
      return createMailing({
        html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
        listId: "list_race",
        name: null,
        purpose: "marketing",
        recipients: null,
        scheduledAt: null,
        subject: "Race",
        text: null,
      });
    case "delete-list":
      return deleteList("list_race");
    default:
      return Effect.die(`Unknown race fixture operation: ${operationName}`);
  }
}

async function waitForFile(path: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (existsSync(path)) return;
    // oxlint-disable-next-line no-await-in-loop -- bounded polling observes a cross-process file barrier sequentially.
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
