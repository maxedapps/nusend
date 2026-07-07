// Driver-agnostic synchronous SQLite service. Interface + key only — driver
// implementations live in database-bun.ts (production) and testing/layers.ts (node).
import { Context, Effect, Exit } from "effect";

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
