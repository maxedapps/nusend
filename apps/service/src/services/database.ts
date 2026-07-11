// Driver-agnostic synchronous SQLite service. Interface + key only — driver
// implementations live in database-bun.ts (production) and testing/layers.ts (node).
import { Context, Effect, Exit, Option, type Semaphore } from "effect";

import { DatabaseError } from "../errors.ts";

export type SqlParams = Record<string, string | number | null>;

export interface DatabaseService {
  readonly run: (
    operation: string,
    sql: string,
    params?: SqlParams,
  ) => Effect.Effect<void, DatabaseError>;
  readonly get: <T>(
    operation: string,
    sql: string,
    params?: SqlParams,
  ) => Effect.Effect<T | null, DatabaseError>;
  readonly all: <T>(
    operation: string,
    sql: string,
    params?: SqlParams,
  ) => Effect.Effect<readonly T[], DatabaseError>;
  // Multi-statement SQL (migration files). Prepared statements silently ignore or
  // part-execute trailing statements on both drivers — everything else must stay
  // single-statement and go through run/get/all.
  readonly exec: (operation: string, sql: string) => Effect.Effect<void, DatabaseError>;
  readonly ping: Effect.Effect<boolean>;
  // Interactive transaction. Work must perform DB-only effects: a suspended fiber
  // inside the transaction would hold SQLite's write lock.
  readonly transaction: <A, E, R>(
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, DatabaseError | E, R>;
}

export const Database = Context.Service<DatabaseService>("nusend/Database");

// Fiber-scoped marker set only inside a transaction's `work` (see
// serializeDatabaseService). It must be fiber-scoped, not shared closure state:
// a shared flag set by a suspended permit-holder would be read by a concurrent
// fiber, which would then wrongly bypass the semaphore and write inside the open
// transaction. Do NOT fork long-lived fibers inside transaction `work` — a fork
// inherits the marker and would keep bypassing serialization after the
// transaction ends (`work` is documented DB-only above).
export const InTransaction = Context.Service<true>("nusend/InTransaction");

// Serializes all access to one SQLite connection through a single-permit
// semaphore, so concurrent request fibers cannot interleave statements into an
// open transaction (which SQLite runs on the shared connection). Statements
// issued from inside a transaction's `work` carry the InTransaction marker and
// bypass acquisition — the permit is already held, so re-acquiring would
// deadlock. `ping` stays unserialized: it is read-only and must answer during
// startup before anything else runs.
export function serializeDatabaseService(
  raw: DatabaseService,
  semaphore: Semaphore.Semaphore,
): DatabaseService {
  const serialize = <A>(effect: Effect.Effect<A, DatabaseError>): Effect.Effect<A, DatabaseError> =>
    Effect.serviceOption(InTransaction).pipe(
      Effect.flatMap((marker) =>
        Option.isSome(marker) ? effect : semaphore.withPermits(1)(effect),
      ),
    );

  return {
    all: <T>(operation: string, sql: string, params?: SqlParams) =>
      serialize(raw.all<T>(operation, sql, params)),
    exec: (operation, sql) => serialize(raw.exec(operation, sql)),
    get: <T>(operation: string, sql: string, params?: SqlParams) =>
      serialize(raw.get<T>(operation, sql, params)),
    ping: raw.ping,
    run: (operation, sql, params) => serialize(raw.run(operation, sql, params)),
    // A nested transaction (marker already present) runs raw: its BEGIN fails at
    // `transaction:begin` exactly as before, without acquiring the held permit
    // (which would self-deadlock). A top-level transaction acquires the permit
    // and provides the marker to `work` so nested statements bypass.
    transaction: (work) =>
      Effect.serviceOption(InTransaction).pipe(
        Effect.flatMap((marker) => {
          const inner = raw.transaction(Effect.provideService(work, InTransaction, true));
          return Option.isSome(marker) ? inner : semaphore.withPermits(1)(inner);
        }),
      ),
  };
}

// Shared BEGIN IMMEDIATE / COMMIT / ROLLBACK combinator so both drivers cannot
// drift. `execRaw` runs one statement synchronously on the underlying connection.
// Rollback is armed only after BEGIN succeeds (a failed BEGIN — e.g. an unsupported
// nested transaction — must not roll back a caller's transaction) and fires on every
// non-success exit (typed failure, defect, interruption), not just typed failures.
export function makeTransaction(
  execRaw: (operation: string, sql: string) => Effect.Effect<void, DatabaseError>,
): DatabaseService["transaction"] {
  const rollback = execRaw("transaction:rollback", "ROLLBACK;").pipe(Effect.ignore);

  return (work) =>
    execRaw("transaction:begin", "BEGIN IMMEDIATE;").pipe(
      Effect.flatMap(() =>
        work.pipe(
          Effect.tap(() => execRaw("transaction:commit", "COMMIT;")),
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : rollback)),
        ),
      ),
    );
}
