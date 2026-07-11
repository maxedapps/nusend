// Driver contract exercised against both Database layers: node:sqlite in-process
// (vitest) and bun:sqlite (bun-scenario). Keeps the two implementations honest.
import { Data, Effect, Exit, Layer, ManagedRuntime } from "effect";

import type { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";

class ContractRollbackError extends Data.TaggedError("ContractRollbackError")<{}> {}

function check(label: string, actual: unknown, expected: unknown): Effect.Effect<void> {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  return actualJson === expectedJson
    ? Effect.void
    : Effect.die(new Error(`${label}: expected ${expectedJson}, got ${actualJson}`));
}

const exerciseDatabaseContract: Effect.Effect<void, DatabaseError, DatabaseService> = Effect.gen(
  function* () {
    const db = yield* Database;

    // exec runs multi-statement SQL (the migration-file case).
    yield* db.exec(
      "contract:setup",
      `CREATE TABLE contract_probe (id TEXT PRIMARY KEY, label TEXT NOT NULL);
       INSERT INTO contract_probe (id, label) VALUES ('seed', 'from exec');`,
    );

    yield* db.run(
      "contract:insert",
      "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
      {
        id: "row_1",
        label: "one",
      },
    );

    // exec must not split on semicolons inside -- or /* */ comments.
    yield* db.exec(
      "contract:comment-setup",
      `-- leading comment; with a semicolon
       CREATE TABLE contract_comment (id TEXT PRIMARY KEY); /* block; comment */
       INSERT INTO contract_comment (id) VALUES ('c1'); -- trailing; comment`,
    );
    const commentRow = yield* db.get<{ id: string }>(
      "contract:comment-get",
      "SELECT id FROM contract_comment WHERE id = 'c1';",
    );
    yield* check("exec handles comment-embedded semicolons", commentRow, { id: "c1" });

    const row = yield* db.get<{ id: string; label: string }>(
      "contract:get",
      "SELECT id, label FROM contract_probe WHERE id = $id;",
      { id: "row_1" },
    );
    yield* check("get returns the row", row, { id: "row_1", label: "one" });

    const missing = yield* db.get(
      "contract:get-missing",
      "SELECT id FROM contract_probe WHERE id = $id;",
      {
        id: "nope",
      },
    );
    yield* check("get returns null for no row", missing, null);

    const all = yield* db.all<{ id: string }>(
      "contract:all",
      "SELECT id FROM contract_probe ORDER BY id ASC;",
    );
    yield* check(
      "all returns every row ordered",
      all.map((entry) => entry.id),
      ["row_1", "seed"],
    );

    const failure = yield* db
      .run("contract:bad-sql", "INSERT INTO does_not_exist (id) VALUES ('x');")
      .pipe(
        Effect.map(() => null),
        Effect.catchTag("DatabaseError", (error) => Effect.succeed(error.operation)),
      );
    yield* check("failures carry the operation label", failure, "contract:bad-sql");

    yield* db.transaction(
      Effect.gen(function* () {
        yield* db.run(
          "contract:tx-insert",
          "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
          {
            id: "tx_1",
            label: "committed",
          },
        );
        yield* db.run(
          "contract:tx-insert",
          "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
          {
            id: "tx_2",
            label: "committed",
          },
        );
      }),
    );
    const afterCommit = yield* db.get<{ n: number }>(
      "contract:count",
      "SELECT COUNT(*) AS n FROM contract_probe;",
    );
    yield* check("transaction commits", afterCommit, { n: 4 });

    const rolledBack = yield* db
      .transaction(
        Effect.gen(function* () {
          yield* db.run(
            "contract:tx-rollback-insert",
            "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
            { id: "tx_3", label: "rolled back" },
          );
          return yield* Effect.fail(new ContractRollbackError());
        }),
      )
      .pipe(
        Effect.map(() => "no failure"),
        Effect.catchTag("ContractRollbackError", () => Effect.succeed("typed failure surfaced")),
      );
    yield* check("typed failure escapes the transaction", rolledBack, "typed failure surfaced");

    const afterRollback = yield* db.get<{ n: number }>(
      "contract:count",
      "SELECT COUNT(*) AS n FROM contract_probe;",
    );
    yield* check("typed failure rolls the transaction back", afterRollback, { n: 4 });

    const defectExit = yield* db
      .transaction(
        Effect.gen(function* () {
          yield* db.run(
            "contract:tx-defect-insert",
            "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
            { id: "tx_defect", label: "rolled back" },
          );
          return yield* Effect.die(new Error("defect inside transaction"));
        }),
      )
      .pipe(Effect.exit);
    yield* check("defect surfaces as a failure exit", Exit.isSuccess(defectExit), false);

    const afterDefect = yield* db.get<{ n: number }>(
      "contract:count",
      "SELECT COUNT(*) AS n FROM contract_probe;",
    );
    yield* check("defect rolls the transaction back", afterDefect, { n: 4 });

    // An unsupported nested transaction must fail at its own BEGIN without issuing
    // a ROLLBACK against the caller's transaction.
    yield* db.transaction(
      Effect.gen(function* () {
        yield* db.run(
          "contract:nested-outer-insert",
          "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
          { id: "nested_a", label: "outer before" },
        );

        const nested = yield* db.transaction(Effect.void).pipe(
          Effect.map(() => "unexpectedly succeeded"),
          Effect.catchTag("DatabaseError", (error) => Effect.succeed(error.operation)),
        );
        yield* check("nested transaction fails at BEGIN", nested, "transaction:begin");

        yield* db.run(
          "contract:nested-outer-insert",
          "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
          { id: "nested_b", label: "outer after" },
        );
      }),
    );

    const afterNested = yield* db.all<{ id: string }>(
      "contract:nested-rows",
      "SELECT id FROM contract_probe WHERE id IN ('nested_a', 'nested_b') ORDER BY id ASC;",
    );
    yield* check(
      "caught nested failure does not roll back the outer transaction",
      afterNested.map((entry) => entry.id),
      ["nested_a", "nested_b"],
    );

    // Concurrent access must be serialized: a plain write running while another
    // fiber holds an open transaction must NOT execute inside that transaction
    // (and be lost when it rolls back). Effect.yieldNow forces the transaction
    // fiber to suspend mid-transaction — the exact preemption that reproduced the
    // silent-rollback bug — so this does not rely on the auto-yield op budget.
    yield* db.run("contract:race-seed", "DELETE FROM contract_probe WHERE id = $id;", {
      id: "race_plain",
    });
    yield* Effect.all(
      [
        db
          .transaction(
            Effect.gen(function* () {
              yield* db.run(
                "contract:race-tx-insert",
                "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
                { id: "race_tx", label: "rolled back" },
              );
              yield* Effect.yieldNow;
              return yield* Effect.fail(new ContractRollbackError());
            }),
          )
          .pipe(Effect.catchTag("ContractRollbackError", () => Effect.void)),
        db.run(
          "contract:race-plain-insert",
          "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
          { id: "race_plain", label: "committed" },
        ),
      ],
      { concurrency: "unbounded" },
    );
    const racePlain = yield* db.get<{ id: string }>(
      "contract:race-plain-check",
      "SELECT id FROM contract_probe WHERE id = $id;",
      { id: "race_plain" },
    );
    yield* check("concurrent plain write survives a rolling-back transaction", racePlain, {
      id: "race_plain",
    });
    const raceTx = yield* db.get(
      "contract:race-tx-check",
      "SELECT id FROM contract_probe WHERE id = $id;",
      { id: "race_tx" },
    );
    yield* check("the rolled-back transaction's own row is gone", raceTx, null);

    // Two concurrent transactions must serialize, not collide with
    // "cannot start a transaction within a transaction".
    const bothCommitted = yield* Effect.all(
      [
        db.transaction(
          db.run(
            "contract:race-tx-a",
            "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
            { id: "race_serial_a", label: "committed" },
          ),
        ),
        db.transaction(
          db.run(
            "contract:race-tx-b",
            "INSERT INTO contract_probe (id, label) VALUES ($id, $label);",
            { id: "race_serial_b", label: "committed" },
          ),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(() => "both committed"),
      Effect.catchTag("DatabaseError", (error) => Effect.succeed(`collided: ${error.operation}`)),
    );
    yield* check("concurrent transactions serialize", bothCommitted, "both committed");

    const alive = yield* db.ping;
    yield* check("ping reports a healthy connection", alive, true);
  },
);

export function runDatabaseContract(
  layer: Layer.Layer<DatabaseService, DatabaseError>,
): Promise<void> {
  return Effect.runPromise(exerciseDatabaseContract.pipe(Effect.provide(layer)));
}

export async function assertDisposeClosesDatabase(
  layer: Layer.Layer<DatabaseService, DatabaseError>,
): Promise<void> {
  const runtime = ManagedRuntime.make(layer);
  const db = await runtime.runPromise(Database);
  const beforeDispose = await runtime.runPromise(db.ping);
  await runtime.dispose();
  const afterDispose = await Effect.runPromise(db.ping);

  if (!(beforeDispose === true && afterDispose === false)) {
    return Promise.reject(
      new Error(
        `dispose must close the connection: ping before=${beforeDispose} after=${afterDispose}`,
      ),
    );
  }
}
