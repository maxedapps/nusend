import { describe, expect, it } from "vitest";

import { droppedTableNames } from "./destructive-migration.ts";

describe("droppedTableNames", () => {
  it("ignores comments and string literals while sorting and deduplicating real drops", () => {
    expect(
      droppedTableNames(`
        -- DROP TABLE ignored_line;
        SELECT 'DROP TABLE ignored_string';
        /* DROP TABLE ignored_block; */
        DROP TABLE beta;
        DROP TABLE IF EXISTS alpha;
        DROP TABLE beta;
      `),
    ).toEqual(["alpha", "beta"]);
  });

  it("recognizes ordinary, quoted, bracketed, and schema-qualified identifiers", () => {
    expect(
      droppedTableNames(`
        DROP TABLE ordinary;
        DROP TABLE "double quoted";
        DROP TABLE \`backtick name\`;
        DROP TABLE [bracket name];
        DROP TABLE IF EXISTS main."qualified name";
      `),
    ).toEqual([
      "backtick name",
      "bracket name",
      "double quoted",
      "main.qualified name",
      "ordinary",
    ]);
  });

  it.each([
    "DROP TABLE ;",
    "DROP TABLE IF foo;",
    "DROP TABLE main.;",
    "DROP TABLE main.foo.bar;",
    "DROP TABLE foo bar;",
    "DROP TABLE foo, bar;",
    "DROP TABLE foo!;",
    "DROP TABLE foo();",
    'DROP TABLE "unterminated;',
  ])("rejects malformed recognized SQL: %s", (sql) => {
    expect(() => droppedTableNames(sql)).toThrow();
  });
});
