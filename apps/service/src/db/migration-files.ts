import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "effect";

import { MigrationError } from "../errors.ts";

export const migrationsDirectory = fileURLToPath(new URL("./migrations/sql/", import.meta.url));

export type MigrationFile = {
  checksum: string;
  downSql: string;
  upSql: string;
  version: string;
};

const upMarker = /^\s*--\s*migrate:up\s*$/gim;
const downMarker = /^\s*--\s*migrate:down\s*$/gim;

// The one place that lists, orders, and parses the on-disk migration files —
// the migrate CLI and every test layer/fixture go through this so directory
// layout, ordering, and parsing cannot drift between them.
export function readMigrationFiles(): Result.Result<MigrationFile, MigrationError>[] {
  if (!existsSync(migrationsDirectory)) return [];

  return readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) =>
      parseMigrationFile(
        basename(fileName, ".sql"),
        readFileSync(join(migrationsDirectory, fileName), "utf8"),
      ),
    );
}

export function parseMigrationFile(
  version: string,
  content: string,
): Result.Result<MigrationFile, MigrationError> {
  const fail = (reason: string) => Result.fail(new MigrationError({ reason, version }));
  const upMatches = findMarkerMatches(content, upMarker);
  const downMatches = findMarkerMatches(content, downMarker);

  if (upMatches.length !== 1) {
    return fail(`Migration ${version} must contain exactly one -- migrate:up marker.`);
  }

  if (downMatches.length !== 1) {
    return fail(`Migration ${version} must contain exactly one -- migrate:down marker.`);
  }

  const upMatch = upMatches[0];
  const downMatch = downMatches[0];

  if (downMatch.index < upMatch.index) {
    return fail(`Migration ${version} must place -- migrate:up before -- migrate:down.`);
  }

  const upSql = content.slice(upMatch.end, downMatch.index).trim();
  const downSql = content.slice(downMatch.end).trim();

  if (upSql.length === 0) {
    return fail(`Migration ${version} has an empty up section.`);
  }

  if (downSql.length === 0) {
    return fail(`Migration ${version} has an empty down section.`);
  }

  return Result.succeed({
    checksum: checksum(content),
    downSql,
    upSql,
    version,
  });
}

export function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

type MarkerMatch = {
  end: number;
  index: number;
};

function findMarkerMatches(content: string, marker: RegExp): MarkerMatch[] {
  marker.lastIndex = 0;

  return [...content.matchAll(marker)].map((match) => ({
    end: match.index + match[0].length,
    index: match.index,
  }));
}
