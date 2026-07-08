// Production Database layer over bun:sqlite. Also provides SqliteHandle — the raw
// connection — consumed only by the Auth layer (Better Auth needs the bare handle).
import { Database as BunDatabase } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";

import { DatabaseError } from "../errors.ts";
import { Database, makeTransaction, type DatabaseService, type SqlParams } from "./database.ts";

export const SqliteHandle = Context.Service<BunDatabase>("nusend/SqliteHandle");

export function DatabaseBunLive(
  databasePath: string,
): Layer.Layer<BunDatabase | DatabaseService, DatabaseError> {
  return Layer.effectContext(
    Effect.acquireRelease(
      // Acquire registers the close finalizer before any further setup, so a
      // failing pragma cannot leak an open handle (the scope closes it).
      Effect.try({
        try: () => openDatabase(databasePath),
        catch: (cause) => new DatabaseError({ cause, operation: "open" }),
      }),
      (db) => Effect.sync(() => db.close(false)),
    ).pipe(
      Effect.tap((db) =>
        Effect.try({
          try: () => applyConnectionPragmas(db),
          catch: (cause) => new DatabaseError({ cause, operation: "pragmas" }),
        }),
      ),
      Effect.map((db) =>
        Context.make(Database, makeService(db)).pipe(Context.add(SqliteHandle, db)),
      ),
    ),
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
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA trusted_schema = OFF;");
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
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
