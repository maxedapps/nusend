// Owner bootstrap CLI: bun src/auth/bootstrap.ts --email <email> --name <name>
// --workspace <name> --slug <slug> [--force]
import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime } from "effect";

import { serviceConfig } from "../config.ts";
import { BootstrapError, type DatabaseError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, IdGeneratorLive, type IdGeneratorService } from "../services/ids.ts";

type BootstrapOptions = {
  email: string;
  force?: boolean;
  name: string;
  slug: string;
  workspace: string;
};

export type BootstrapResult = {
  organizationId: string;
  userId: string;
};

export function bootstrapOwner(
  options: BootstrapOptions,
): Effect.Effect<
  BootstrapResult,
  BootstrapError | DatabaseError,
  DatabaseService | IdGeneratorService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;
    const now = yield* currentIso;

    // One transaction for the whole bootstrap (intentional improvement over the
    // pre-Effect version's independent upserts). Check order matches the
    // pre-Effect version: schema, then existing owner, then email validity.
    return yield* db.transaction(
      Effect.gen(function* () {
        const hasAuthUsers = yield* db.get(
          "bootstrap:ensure-schema",
          "SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = 'users';",
        );
        if (hasAuthUsers === null) {
          return yield* Effect.fail(
            new BootstrapError({ reason: "Auth schema is not migrated. Run db:migrate first." }),
          );
        }

        if (!options.force) {
          const owner = yield* db.get(
            "bootstrap:owner-exists",
            "SELECT 1 AS ok FROM organization_members WHERE role = 'owner' LIMIT 1;",
          );
          if (owner !== null) {
            return yield* Effect.fail(
              new BootstrapError({
                reason: "An owner already exists. Use --force to add another owner.",
              }),
            );
          }
        }

        const email = normalizeEmail(options.email);
        if (email === null) {
          return yield* Effect.fail(
            new BootstrapError({ reason: "--email must be a valid email address." }),
          );
        }

        const userId = yield* upsertUser(db, ids, { email, name: options.name.trim(), now });
        const organizationId = yield* upsertOrganization(db, ids, {
          name: options.workspace.trim(),
          now,
          slug: options.slug.trim(),
        });
        yield* upsertOwnerMember(db, ids, { now, organizationId, userId });

        return { organizationId, userId };
      }),
    );
  });
}

function upsertUser(
  db: DatabaseService,
  ids: IdGeneratorService,
  input: { email: string; name: string; now: string },
): Effect.Effect<string, DatabaseError> {
  return Effect.gen(function* () {
    const existing = yield* db.get<{ id: string }>(
      "bootstrap:find-user",
      "SELECT id FROM users WHERE email = $email LIMIT 1;",
      { email: input.email },
    );

    if (existing) {
      yield* db.run(
        "bootstrap:update-user",
        `UPDATE users
         SET name = $name, email_verified = 1, updated_at = $now
         WHERE id = $id;`,
        { id: existing.id, name: input.name, now: input.now },
      );
      return existing.id;
    }

    const id = yield* ids.next;
    yield* db.run(
      "bootstrap:insert-user",
      `INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at)
       VALUES ($id, $name, $email, 1, NULL, $now, $now);`,
      { email: input.email, id, name: input.name, now: input.now },
    );

    return id;
  });
}

function upsertOrganization(
  db: DatabaseService,
  ids: IdGeneratorService,
  input: { name: string; now: string; slug: string },
): Effect.Effect<string, DatabaseError> {
  return Effect.gen(function* () {
    const existing = yield* db.get<{ id: string }>(
      "bootstrap:find-organization",
      "SELECT id FROM organizations WHERE slug = $slug LIMIT 1;",
      { slug: input.slug },
    );

    if (existing) {
      yield* db.run(
        "bootstrap:update-organization",
        "UPDATE organizations SET name = $name WHERE id = $id;",
        { id: existing.id, name: input.name },
      );
      return existing.id;
    }

    const id = yield* ids.next;
    yield* db.run(
      "bootstrap:insert-organization",
      `INSERT INTO organizations (id, name, slug, logo, created_at, metadata)
       VALUES ($id, $name, $slug, NULL, $now, NULL);`,
      { id, name: input.name, now: input.now, slug: input.slug },
    );

    return id;
  });
}

function upsertOwnerMember(
  db: DatabaseService,
  ids: IdGeneratorService,
  input: { now: string; organizationId: string; userId: string },
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const existing = yield* db.get<{ id: string }>(
      "bootstrap:find-member",
      `SELECT id FROM organization_members
       WHERE organization_id = $organizationId AND user_id = $userId
       LIMIT 1;`,
      { organizationId: input.organizationId, userId: input.userId },
    );

    if (existing) {
      yield* db.run(
        "bootstrap:update-member",
        "UPDATE organization_members SET role = 'owner' WHERE id = $id;",
        { id: existing.id },
      );
      return;
    }

    const id = yield* ids.next;
    yield* db.run(
      "bootstrap:insert-member",
      `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
       VALUES ($id, $organizationId, $userId, 'owner', $now);`,
      { id, now: input.now, organizationId: input.organizationId, userId: input.userId },
    );
  });
}

function normalizeEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();

  if (!normalized || !normalized.includes("@")) return null;

  return normalized;
}

function parseArgs(argv: string[]): BootstrapOptions {
  const values = new Map<string, string>();
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}.`);
    }

    values.set(arg.slice(2), value);
    index += 1;
  }

  const email = values.get("email");
  const name = values.get("name");
  const workspace = values.get("workspace");
  const slug = values.get("slug");

  if (!email || !name || !workspace || !slug) {
    throw new Error(
      "Usage: bun src/auth/bootstrap.ts --email <email> --name <name> --workspace <name> --slug <slug> [--force]",
    );
  }

  return { email, force, name, slug, workspace };
}

if (import.meta.main) {
  // Lazy so importing `bootstrapOwner` in vitest (Node) never loads bun:sqlite.
  const { DatabaseBunLive } = await import("../services/database-bun.ts");
  const options = parseArgs(process.argv.slice(2));
  const config = await Effect.runPromise(
    serviceConfig.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
    ),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(DatabaseBunLive(config.databasePath), IdGeneratorLive),
  );

  try {
    const exit = await runtime.runPromiseExit(
      bootstrapOwner(options).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            console.log(
              `Bootstrapped owner ${options.email.toLowerCase()} in workspace ${result.organizationId}.`,
            );
          }),
        ),
        Effect.catchTags({
          BootstrapError: (error) =>
            Effect.sync(() => {
              console.error(error.reason);
              process.exitCode = 1;
            }),
          DatabaseError: (error) =>
            Effect.sync(() => {
              console.error(`Database error during ${error.operation}: ${String(error.cause)}`);
              process.exitCode = 1;
            }),
        }),
      ),
    );

    if (Exit.isFailure(exit)) {
      console.error(String(exit.cause));
      process.exitCode = 1;
    }
  } finally {
    await runtime.dispose();
  }
}
