import { Result } from "effect";
import { describe, expect, it } from "vitest";

import type { MigrationError } from "../errors.ts";
import { checksum, parseMigrationFile, type MigrationFile } from "./migration-files.ts";

function failureReason(result: Result.Result<MigrationFile, MigrationError>): string {
  return Result.isFailure(result) ? result.failure.reason : "unexpected success";
}

describe("parseMigrationFile", () => {
  it("uses the whole non-empty file as forward SQL", () => {
    const content = "CREATE TABLE test (id TEXT PRIMARY KEY);\n";
    const migration = Result.getOrThrow(parseMigrationFile("0001_test", content));

    expect(migration).toEqual({
      checksum: checksum(content),
      sql: "CREATE TABLE test (id TEXT PRIMARY KEY);",
      version: "0001_test",
    });
  });

  it.each(["", "  \n\t"])("rejects an empty migration", (content) => {
    expect(failureReason(parseMigrationFile("0001_empty", content))).toMatch(/empty/);
  });

  it("carries the version on failures", () => {
    const result = parseMigrationFile("0042_broken", "");

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.version).toBe("0042_broken");
    }
  });
});
