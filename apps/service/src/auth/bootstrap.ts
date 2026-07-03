import type { Database } from "bun:sqlite";

import { loadConfig } from "../config.ts";
import { closeDatabase, openDatabase } from "../db/index.ts";

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

export function bootstrapOwner(db: Database, options: BootstrapOptions): BootstrapResult {
  ensureAuthSchema(db);

  if (!options.force && ownerExists(db)) {
    throw new Error("An owner already exists. Use --force to add another owner.");
  }

  const email = normalizeEmail(options.email);
  const now = new Date().toISOString();
  const userId = upsertUser(db, {
    email,
    name: options.name.trim(),
    now,
  });
  const organizationId = upsertOrganization(db, {
    name: options.workspace.trim(),
    now,
    slug: options.slug.trim(),
  });

  upsertOwnerMember(db, {
    now,
    organizationId,
    userId,
  });

  return { organizationId, userId };
}

function ensureAuthSchema(db: Database): void {
  const hasAuthUsers = db
    .query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'users';")
    .get();

  if (!hasAuthUsers) {
    throw new Error("Auth schema is not migrated. Run db:migrate first.");
  }
}

function ownerExists(db: Database): boolean {
  const row = db.query("SELECT 1 FROM organization_members WHERE role = 'owner' LIMIT 1;").get();

  return Boolean(row);
}

function upsertUser(db: Database, input: { email: string; name: string; now: string }): string {
  const existing = db
    .query("SELECT id FROM users WHERE email = $email LIMIT 1;")
    .get({ email: input.email }) as { id: string } | null;
  const id = existing?.id ?? createId();

  if (existing) {
    db.query(
      `UPDATE users
       SET name = $name, email_verified = 1, updated_at = $now
       WHERE id = $id;`,
    ).run({ id, name: input.name, now: input.now });
    return id;
  }

  db.query(
    `INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at)
     VALUES ($id, $name, $email, 1, NULL, $now, $now);`,
  ).run({ email: input.email, id, name: input.name, now: input.now });

  return id;
}

function upsertOrganization(
  db: Database,
  input: { name: string; now: string; slug: string },
): string {
  const existing = db
    .query("SELECT id FROM organizations WHERE slug = $slug LIMIT 1;")
    .get({ slug: input.slug }) as { id: string } | null;
  const id = existing?.id ?? createId();

  if (existing) {
    db.query("UPDATE organizations SET name = $name WHERE id = $id;").run({
      id,
      name: input.name,
    });
    return id;
  }

  db.query(
    `INSERT INTO organizations (id, name, slug, logo, created_at, metadata)
     VALUES ($id, $name, $slug, NULL, $now, NULL);`,
  ).run({ id, name: input.name, now: input.now, slug: input.slug });

  return id;
}

function upsertOwnerMember(
  db: Database,
  input: { now: string; organizationId: string; userId: string },
): void {
  const existing = db
    .query(
      `SELECT id FROM organization_members
       WHERE organization_id = $organizationId AND user_id = $userId
       LIMIT 1;`,
    )
    .get(input) as { id: string } | null;

  if (existing) {
    db.query("UPDATE organization_members SET role = 'owner' WHERE id = $id;").run({
      id: existing.id,
    });
    return;
  }

  db.query(
    `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
     VALUES ($id, $organizationId, $userId, 'owner', $now);`,
  ).run({ ...input, id: createId() });
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();

  if (!normalized || !normalized.includes("@")) {
    throw new Error("--email must be a valid email address.");
  }

  return normalized;
}

function createId(): string {
  return crypto.randomUUID();
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
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = openDatabase(config.databasePath);

  try {
    const result = bootstrapOwner(db, options);
    console.log(
      `Bootstrapped owner ${options.email.toLowerCase()} in workspace ${result.organizationId}.`,
    );
  } finally {
    closeDatabase(db);
  }
}
