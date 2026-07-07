import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export function openDatabase(databasePath: string): Database {
  ensureDatabaseDirectory(databasePath);

  const db = new Database(databasePath, {
    create: true,
    strict: true,
  });

  applyConnectionPragmas(db);

  return db;
}

export function closeDatabase(db: Database): void {
  db.close(false);
}

export function pingDatabase(db: Database): boolean {
  try {
    db.query("SELECT 1 AS ok;").get();
    return true;
  } catch {
    return false;
  }
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") return;

  mkdirSync(dirname(databasePath), { recursive: true });
}

function applyConnectionPragmas(db: Database): void {
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA trusted_schema = OFF;");
}
