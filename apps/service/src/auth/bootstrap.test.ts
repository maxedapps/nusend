import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { runTest } from "../testing/layers.ts";
import { bootstrapOwner } from "./bootstrap.ts";

describe("bootstrapOwner", () => {
  it("creates the first owner, workspace, and membership", async () => {
    const output = await runTest(
      Effect.gen(function* () {
        const result = yield* bootstrapOwner({
          email: "Max@Example.com",
          name: "Max",
          slug: "nusend",
          workspace: "Nusend",
        });
        const db = yield* Database;

        return {
          accounts: yield* db.get<{ count: number }>(
            "count-accounts",
            "SELECT COUNT(*) AS count FROM accounts;",
          ),
          member: yield* db.get<{ organization_id: string; role: string }>(
            "find-member",
            "SELECT organization_id, role FROM organization_members WHERE user_id = $userId;",
            { userId: result.userId },
          ),
          organization: yield* db.get<{ name: string; slug: string }>(
            "find-organization",
            "SELECT name, slug FROM organizations WHERE id = $id;",
            { id: result.organizationId },
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
    expect(output.organization).toEqual({ name: "Nusend", slug: "nusend" });
    expect(output.member).toEqual({
      organization_id: output.result.organizationId,
      role: "owner",
    });
    expect(output.accounts).toEqual({ count: 0 });
  });

  it("refuses a second owner without force", async () => {
    const reason = await runTest(
      Effect.gen(function* () {
        yield* bootstrapOwner({
          email: "max@example.com",
          name: "Max",
          slug: "nusend",
          workspace: "Nusend",
        });

        return yield* bootstrapOwner({
          email: "team@example.com",
          name: "Team",
          slug: "nusend",
          workspace: "Nusend",
        }).pipe(
          Effect.map(() => "unexpected success"),
          Effect.catchTag("BootstrapError", (error) => Effect.succeed(error.reason)),
        );
      }),
    );

    expect(reason).toContain("owner already exists");
  });

  it("allows a second owner with force", async () => {
    const owners = await runTest(
      Effect.gen(function* () {
        yield* bootstrapOwner({
          email: "max@example.com",
          name: "Max",
          slug: "nusend",
          workspace: "Nusend",
        });
        yield* bootstrapOwner({
          email: "team@example.com",
          force: true,
          name: "Team",
          slug: "nusend",
          workspace: "Nusend",
        });

        const db = yield* Database;
        return yield* db.get<{ count: number }>(
          "count-owners",
          "SELECT COUNT(*) AS count FROM organization_members WHERE role = 'owner';",
        );
      }),
    );

    expect(owners).toEqual({ count: 2 });
  });

  it("rejects invalid emails", async () => {
    const reason = await runTest(
      bootstrapOwner({
        email: "not-an-email",
        name: "Max",
        slug: "nusend",
        workspace: "Nusend",
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
        slug: "nusend",
        workspace: "Nusend",
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
        slug: "nusend",
        workspace: "Nusend",
      }).pipe(
        Effect.map(() => "unexpected success"),
        Effect.catchTag("BootstrapError", (error) => Effect.succeed(error.reason)),
      ),
      { migrate: false },
    );

    expect(reason).toContain("not migrated");
  });
});
