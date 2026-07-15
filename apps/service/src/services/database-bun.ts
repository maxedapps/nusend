// Production Database layer over bun:sqlite. Also provides SqliteHandle — the raw
// connection — consumed only by the Auth layer (Better Auth needs the bare handle).
import { Database as BunDatabase } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Context, Effect, Layer, Semaphore } from "effect";

import { DatabaseError } from "../errors.ts";
import {
  Database,
  makeTransaction,
  serializeDatabaseService,
  type DatabaseService,
  type SqlParams,
} from "./database.ts";

export const SqliteHandle = Context.Service<BunDatabase>("nusend/SqliteHandle");

export function DatabaseBunLive(
  databasePath: string,
): Layer.Layer<BunDatabase | DatabaseService, DatabaseError> {
  return Layer.effectContext(
    Effect.gen(function* () {
      // Acquire registers the close finalizer before any further setup, so a
      // failing pragma cannot leak an open handle (the scope closes it).
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => openDatabase(databasePath),
          catch: (cause) => new DatabaseError({ cause, operation: "open" }),
        }),
        (handle) => Effect.sync(() => handle.close(false)),
      );
      yield* Effect.try({
        try: () => applyConnectionPragmas(db),
        catch: (cause) => new DatabaseError({ cause, operation: "pragmas" }),
      });

      // Better Auth runs its own statements on the raw SqliteHandle, outside the
      // Effect Database service, so the app semaphore cannot serialize them
      // against an open app transaction on a shared connection. Give it a second
      // connection (same pragmas) so the two never interleave on one handle.
      // Wrapping Better Auth in the app semaphore is rejected: its handler does
      // the Google OAuth token-exchange network call, so holding the DB permit
      // across it would stall all database access on a network round trip. WAL
      // (already set) allows one writer + concurrent readers across connections;
      // busy_timeout handles writer contention. `:memory:` cannot split (a second
      // connection is a different database), so it shares the handle — dev-only.
      // Note: synchronous bun:sqlite means a cross-connection write-lock collision
      // blocks the event loop for up to busy_timeout; the window is tiny in
      // practice because app transactions are DB-only and short.
      const authDb =
        databasePath === ":memory:"
          ? db
          : yield* Effect.acquireRelease(
              Effect.try({
                try: () => openDatabase(databasePath),
                catch: (cause) => new DatabaseError({ cause, operation: "open-auth" }),
              }),
              (handle) => Effect.sync(() => handle.close(false)),
            );
      if (authDb !== db) {
        yield* Effect.try({
          try: () => applyConnectionPragmas(authDb),
          catch: (cause) => new DatabaseError({ cause, operation: "pragmas-auth" }),
        });
      }

      const service = serializeDatabaseService(makeService(db), Semaphore.makeUnsafe(1));
      return Context.make(Database, service).pipe(Context.add(SqliteHandle, authDb));
    }),
  );
}

function openDatabase(databasePath: string): BunDatabase {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  return new BunDatabase(databasePath, { create: true, strict: true });
}

function applyConnectionPragmas(db: BunDatabase): void {
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = FULL;");
  const synchronous = db.query("PRAGMA synchronous;").get() as {
    readonly synchronous?: unknown;
  } | null;
  if (synchronous?.synchronous !== 2) {
    throw new Error("SQLite did not apply required synchronous=FULL mode (2).");
  }
  db.run("PRAGMA trusted_schema = OFF;");
}

// Splits multi-statement migration SQL on top-level semicolons, ignoring
// semicolons inside string literals and -- / block comments. Trigger bodies
// (BEGIN ... END; with internal semicolons) are NOT supported — keep migrations
// out of trigger definitions, or apply them as a single non-split statement.
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (quote === null) {
      // Line comment: skip to end of line (do not emit into `current`).
      if (char === "-" && next === "-") {
        while (index < sql.length && sql[index] !== "\n") index += 1;
        current += "\n";
        continue;
      }
      // Block comment: skip to the closing */.
      if (char === "/" && next === "*") {
        index += 2;
        while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
        index += 1;
        current += " ";
        continue;
      }
    }

    current += char;

    if (quote === "'" && char === "'" && next === "'") {
      current += next;
      index += 1;
      continue;
    }

    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === ";") {
      const statement = current.trim();
      if (statement.length > 0) statements.push(statement);
      current = "";
    }
  }

  const trailing = current.trim();
  if (trailing.length > 0) statements.push(trailing);

  return statements;
}

function makeService(db: BunDatabase): DatabaseService {
  const exec: DatabaseService["exec"] = (operation, sql) =>
    Effect.try({
      try: () => {
        for (const statement of splitSqlStatements(sql)) {
          db.query(statement).run();
        }
      },
      catch: (cause) => new DatabaseError({ cause, operation }),
    });

  return {
    all: (operation, sql, params) =>
      Effect.try({
        try: () => db.query(sql).all(params ?? {}) as never,
        catch: (cause) => new DatabaseError({ cause, operation }),
      }),
    exec,
    get: (operation, sql, params) =>
      Effect.try({
        try: () => db.query(sql).get(params ?? {}) as never,
        catch: (cause) => new DatabaseError({ cause, operation }),
      }),
    ping: Effect.sync(() => {
      try {
        db.query("SELECT 1 AS ok;").get();
        return true;
      } catch {
        return false;
      }
    }),
    run: (operation, sql, params: SqlParams | undefined) =>
      Effect.try({
        try: () => {
          db.query(sql).run(params ?? {});
        },
        catch: (cause) => new DatabaseError({ cause, operation }),
      }),
    transaction: makeTransaction(exec),
  };
}
