import { Context, Effect, Layer, Redacted } from "effect";
import type {
  ApiKey as ContractApiKey,
  ApiKeyWithSecret as ContractApiKeyWithSecret,
} from "@nusend/api-contract";
import { validatePermissionSet, type PermissionSet } from "@nusend/api-contract/permissions";

import { DatabaseError, ForbiddenError, NotFoundError, RequestValidationError } from "../errors.ts";
import { type Pagination } from "../http/query.ts";
import { addMillisecondsFrom, currentIso, currentTimeMillis, toIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import { buildApiKeyPreview, generateRawApiKey, hashApiKey, safeEqual } from "./crypto.ts";

export type ApiKeyMetadata = ContractApiKey;
export type ApiKeyWithSecret = ContractApiKeyWithSecret;

export type ApiKeyVerification = {
  readonly key: {
    readonly id: string;
    readonly permissions: PermissionSet;
    readonly userId: string;
  } | null;
  readonly valid: boolean;
};

type ApiKeyWriteError = DatabaseError | ForbiddenError | RequestValidationError;

export type ApiKeysPage = {
  readonly hasMore: boolean;
  readonly items: readonly ApiKeyMetadata[];
};

export interface ApiKeysService {
  readonly create: (input: {
    readonly actorPermissions: PermissionSet | "owner";
    readonly expiresAt?: string | null;
    readonly name: string;
    readonly permissions: PermissionSet;
    readonly rotatedFromId?: string | null;
    readonly userId: string;
  }) => Effect.Effect<ApiKeyWithSecret, ApiKeyWriteError, never>;
  readonly list: (
    userId: string,
    pagination: Pagination,
  ) => Effect.Effect<ApiKeysPage, DatabaseError>;
  readonly revoke: (input: {
    readonly actorPermissions: PermissionSet | "owner";
    readonly id: string;
    readonly userId: string;
  }) => Effect.Effect<void, DatabaseError | ForbiddenError | NotFoundError>;
  readonly rotate: (input: {
    readonly actorPermissions: PermissionSet | "owner";
    readonly id: string;
    readonly userId: string;
  }) => Effect.Effect<ApiKeyWithSecret, ApiKeyWriteError | NotFoundError>;
  readonly verify: (key: string) => Effect.Effect<ApiKeyVerification, DatabaseError>;
}

export const ApiKeys = Context.Service<ApiKeysService>("nusend/ApiKeys");

export function ApiKeysLive(
  hashSecret: Redacted.Redacted<string>,
): Layer.Layer<ApiKeysService, never, DatabaseService | IdGeneratorService> {
  return Layer.effect(
    ApiKeys,
    Effect.gen(function* () {
      const db = yield* Database;
      const ids = yield* IdGenerator;
      return makeApiKeysService({ db, hashSecret, ids });
    }),
  );
}

export function makeApiKeysService(input: {
  readonly db: DatabaseService;
  readonly hashSecret: Redacted.Redacted<string>;
  readonly ids: IdGeneratorService;
}): ApiKeysService {
  const service: ApiKeysService = {
    create: (request) =>
      Effect.gen(function* () {
        const nameError = validateName(request.name);
        if (nameError) return yield* Effect.fail(nameError);
        const permissionResult = validatePermissionSet(request.permissions);
        if (!permissionResult.ok) {
          return yield* Effect.fail(
            new RequestValidationError({ message: permissionResult.message }),
          );
        }
        const subsetError = enforceSubset(request.permissions, request.actorPermissions);
        if (subsetError) return yield* Effect.fail(subsetError);

        const nowMs = yield* currentTimeMillis;
        const expiresAt = validateExpiresAt(request.expiresAt ?? null, nowMs);
        if (expiresAt instanceof RequestValidationError) return yield* Effect.fail(expiresAt);

        const rawKey = generateRawApiKey();
        const now = toIso(nowMs);
        const metadata = {
          createdAt: now,
          expiresAt,
          id: yield* input.ids.next,
          lastUsedAt: null,
          name: request.name.trim(),
          permissions: request.permissions,
          preview: buildApiKeyPreview(rawKey),
          revokedAt: null,
        } satisfies ApiKeyMetadata;

        yield* input.db.run(
          "apiKeys:create",
          `INSERT INTO api_keys (id, user_id, name, key_hash, key_preview, permissions_json, created_at, last_used_at, expires_at, revoked_at, rotated_from_id)
           VALUES ($id, $userId, $name, $keyHash, $keyPreview, $permissionsJson, $createdAt, NULL, $expiresAt, NULL, $rotatedFromId);`,
          {
            createdAt: metadata.createdAt,
            expiresAt: metadata.expiresAt,
            id: metadata.id,
            keyHash: hashApiKey(rawKey, input.hashSecret),
            keyPreview: metadata.preview,
            name: metadata.name,
            permissionsJson: JSON.stringify(metadata.permissions),
            rotatedFromId: request.rotatedFromId ?? null,
            userId: request.userId,
          },
        );

        return { ...metadata, key: rawKey } satisfies ApiKeyWithSecret;
      }),
    list: (userId, pagination) =>
      Effect.gen(function* () {
        const rows = yield* input.db.all<ApiKeyRow>(
          "apiKeys:list",
          `SELECT id, user_id, name, key_preview, permissions_json, created_at, last_used_at, expires_at, revoked_at
           FROM api_keys
           WHERE user_id = $userId
           ORDER BY created_at DESC, id DESC
           LIMIT $limit OFFSET $offset;`,
          { limit: pagination.limit + 1, offset: pagination.offset, userId },
        );
        const hasMore = rows.length > pagination.limit;
        const page = hasMore ? rows.slice(0, pagination.limit) : rows;
        return { hasMore, items: yield* Effect.all(page.map(rowToMetadata)) };
      }),
    revoke: ({ actorPermissions, id, userId }) =>
      Effect.gen(function* () {
        const row = yield* input.db.get<{ id: string; permissions_json: string }>(
          "apiKeys:findForRevoke",
          `SELECT id, permissions_json FROM api_keys WHERE id = $id AND user_id = $userId AND revoked_at IS NULL;`,
          { id, userId },
        );
        if (!row) return yield* Effect.fail(new NotFoundError({ message: "API key not found." }));

        // A scoped actor may only revoke a key whose permissions it fully holds,
        // matching rotate — otherwise a narrow api_keys:write key could revoke the
        // owner's broadest key (a lockout vector).
        const targetPermissions = yield* parseStoredPermissions(
          "apiKeys:parseStoredPermissions",
          row.permissions_json,
        );
        const subsetError = enforceSubset(targetPermissions, actorPermissions);
        if (subsetError) return yield* Effect.fail(subsetError);

        const revokedAt = yield* currentIso;
        yield* input.db.run(
          "apiKeys:revoke",
          `UPDATE api_keys SET revoked_at = $revokedAt WHERE id = $id AND user_id = $userId;`,
          { id, revokedAt, userId },
        );
      }),
    rotate: ({ actorPermissions, id, userId }) =>
      input.db.transaction(
        Effect.gen(function* () {
          const existing = yield* input.db.get<ApiKeyRow>(
            "apiKeys:findForRotate",
            `SELECT id, user_id, name, key_preview, permissions_json, created_at, last_used_at, expires_at, revoked_at
             FROM api_keys
             WHERE id = $id AND user_id = $userId AND revoked_at IS NULL;`,
            { id, userId },
          );
          if (!existing) {
            return yield* Effect.fail(new NotFoundError({ message: "API key not found." }));
          }

          const nowMs = yield* currentTimeMillis;
          const permissions = yield* parseStoredPermissions(
            "apiKeys:parseStoredPermissions",
            existing.permissions_json,
          );
          const created = yield* service.create({
            actorPermissions,
            expiresAt: rotationExpiry(existing.expires_at, nowMs),
            name: existing.name,
            permissions,
            rotatedFromId: existing.id,
            userId,
          });

          const revokedAt = toIso(nowMs);
          yield* input.db.run(
            "apiKeys:revokeRotated",
            `UPDATE api_keys SET revoked_at = $revokedAt WHERE id = $id AND user_id = $userId;`,
            { id, revokedAt, userId },
          );

          return created;
        }),
      ),
    verify: (key) =>
      Effect.gen(function* () {
        const hash = hashApiKey(key, input.hashSecret);
        const row = yield* input.db.get<ApiKeyVerifyRow>(
          "apiKeys:verify",
          `SELECT id, user_id, key_hash, permissions_json, expires_at, revoked_at, last_used_at
           FROM api_keys
           WHERE key_hash = $keyHash;`,
          { keyHash: hash },
        );
        if (!row || !safeEqual(row.key_hash, hash)) return { key: null, valid: false };
        if (row.revoked_at !== null) return { key: null, valid: false };
        const nowMs = yield* currentTimeMillis;
        if (row.expires_at !== null) {
          const expiresAtMs = Date.parse(row.expires_at);
          if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
            return { key: null, valid: false };
          }
        }

        const lastUsedAt = toIso(nowMs);
        const cutoff = addMillisecondsFrom(nowMs, -60_000);
        yield* input.db.run(
          "apiKeys:updateLastUsed",
          `UPDATE api_keys
           SET last_used_at = $lastUsedAt
           WHERE id = $id AND (last_used_at IS NULL OR last_used_at < $cutoff);`,
          { cutoff, id: row.id, lastUsedAt },
        );

        return {
          key: {
            id: row.id,
            permissions: yield* parseStoredPermissions(
              "apiKeys:parseStoredPermissions",
              row.permissions_json,
            ),
            userId: row.user_id,
          },
          valid: true,
        };
      }),
  };

  return service;
}

type ApiKeyRow = {
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly id: string;
  readonly key_preview: string;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly permissions_json: string;
  readonly revoked_at: string | null;
  readonly user_id: string;
};

type ApiKeyVerifyRow = {
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly id: string;
  readonly key_hash: string;
  readonly permissions_json: string;
  readonly revoked_at: string | null;
  readonly user_id: string;
};

function rowToMetadata(row: ApiKeyRow): Effect.Effect<ApiKeyMetadata, DatabaseError> {
  return Effect.gen(function* () {
    return {
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      id: row.id,
      lastUsedAt: row.last_used_at,
      name: row.name,
      permissions: yield* parseStoredPermissions(
        "apiKeys:parseStoredPermissions",
        row.permissions_json,
      ),
      preview: row.key_preview,
      revokedAt: row.revoked_at,
    } satisfies ApiKeyMetadata;
  });
}

export function parseStoredPermissions(
  operation: string,
  value: string,
): Effect.Effect<PermissionSet, DatabaseError> {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(value) as PermissionSet,
      catch: (cause) => new DatabaseError({ cause, operation }),
    });
    const result = validatePermissionSet(parsed);
    if (!result.ok) {
      return yield* Effect.fail(new DatabaseError({ cause: new Error(result.message), operation }));
    }
    return parsed;
  });
}

function rotationExpiry(value: string | null, nowMs: number): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp) && timestamp > nowMs) return value;
  return addMillisecondsFrom(nowMs, 365 * 24 * 60 * 60 * 1000);
}

function validateName(value: string): RequestValidationError | null {
  return value.trim().length === 0
    ? new RequestValidationError({ message: "API key name is required." })
    : null;
}

function validateExpiresAt(
  value: string | null,
  nowMs: number,
): string | null | RequestValidationError {
  if (value === null) return null;

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return new RequestValidationError({ message: "API key expiresAt must be a valid date." });
  }
  if (timestamp <= nowMs) {
    return new RequestValidationError({ message: "API key expiresAt must be in the future." });
  }

  return toIso(timestamp);
}

function enforceSubset(
  requested: PermissionSet,
  actorPermissions: PermissionSet | "owner",
): ForbiddenError | null {
  if (actorPermissions === "owner") return null;

  for (const [resource, actions] of Object.entries(requested)) {
    const granted = actorPermissions[resource as keyof PermissionSet] ?? [];
    for (const action of actions ?? []) {
      if (!granted.includes(action)) {
        return new ForbiddenError({ message: "Requested permissions exceed the current API key." });
      }
    }
  }
  return null;
}
