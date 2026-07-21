import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { runTest } from "../testing/layers.ts";
import { bootstrapOwner } from "./bootstrap.ts";

describe("bootstrapOwner", () => {
  it("creates the first owner user", async () => {
    const output = await runTest(
      Effect.gen(function* () {
        const result = yield* bootstrapOwner({
          email: "Max@Example.com",
          name: "Max",
        });
        const db = yield* Database;

        return {
          accounts: yield* db.get<{ count: number }>(
            "count-accounts",
            "SELECT COUNT(*) AS count FROM accounts;",
          ),
          result,
          user: yield* db.get<{ email: string; email_verified: number; name: string }>(
            "find-user",
            "SELECT email, email_verified, name FROM users WHERE id = $id;",
            { id: result.userId },
          ),
        };
      }),
    );

    expect(output.user).toEqual({ email: "max@example.com", email_verified: 1, name: "Max" });
    expect(output.accounts).toEqual({ count: 0 });
  });

  it("is idempotent for the same normalized email", async () => {
    const output = await runTest(
      Effect.gen(function* () {
        const first = yield* bootstrapOwner({
          email: "max@example.com",
          name: "Max",
        });
        const second = yield* bootstrapOwner({
          email: "Max@Example.com",
          name: "Max",
        });
        const db = yield* Database;
        const count = yield* db.get<{ count: number }>(
          "count-owners",
          "SELECT COUNT(*) AS count FROM users;",
        );
        return { count, first, second };
      }),
    );

    expect(output.second.userId).toBe(output.first.userId);
    expect(output.count).toEqual({ count: 1 });
  });

  it("updates the configured owner name on rerun", async () => {
    const user = await runTest(
      Effect.gen(function* () {
        yield* bootstrapOwner({
          email: "max@example.com",
          name: "Max",
        });
        const result = yield* bootstrapOwner({
          email: "max@example.com",
          name: "Maximilian",
        });
        const db = yield* Database;
        return yield* db.get<{ email: string; email_verified: number; name: string }>(
          "find-user",
          "SELECT email, email_verified, name FROM users WHERE id = $id;",
          { id: result.userId },
        );
      }),
    );

    expect(user).toEqual({
      email: "max@example.com",
      email_verified: 1,
      name: "Maximilian",
    });
  });

  it("refuses a conflicting existing owner", async () => {
    const reason = await runTest(
      Effect.gen(function* () {
        yield* bootstrapOwner({
          email: "max@example.com",
          name: "Max",
        });

        return yield* bootstrapOwner({
          email: "team@example.com",
          name: "Team",
        }).pipe(
          Effect.map(() => "unexpected success"),
          Effect.catchTag("BootstrapError", (error) => Effect.succeed(error.reason)),
        );
      }),
    );

    expect(reason).toContain("different email");
  });

  it("rejects invalid emails", async () => {
    const reason = await runTest(
      bootstrapOwner({
        email: "not-an-email",
        name: "Max",
      }).pipe(
        Effect.map(() => "unexpected success"),
        Effect.catchTag("BootstrapError", (error) => Effect.succeed(error.reason)),
      ),
    );

    expect(reason).toContain("--email must be a valid email address.");
  });

  it("reports an unmigrated schema before validating the email", async () => {
    const reason = await runTest(
      bootstrapOwner({
        email: "not-an-email",
        name: "Max",
      }).pipe(
        Effect.map(() => "unexpected success"),
        Effect.catchTag("BootstrapError", (error) => Effect.succeed(error.reason)),
      ),
      { migrate: false },
    );

    expect(reason).toContain("not migrated");
  });

  it("requires migrated auth schema", async () => {
    const reason = await runTest(
      bootstrapOwner({
        email: "max@example.com",
        name: "Max",
      }).pipe(
        Effect.map(() => "unexpected success"),
        Effect.catchTag("BootstrapError", (error) => Effect.succeed(error.reason)),
      ),
      { migrate: false },
    );

    expect(reason).toContain("not migrated");
  });
});
