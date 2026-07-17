import { Context, Effect, Layer, Redacted } from "effect";
import { validatePermissionSet, type PermissionSet } from "@nusend/api-contract/permissions";
import type {
  DeviceAuthorizationStartResponse,
  DeviceAuthorizationTokenResponse,
} from "@nusend/api-contract";

import { ApiKeys, type ApiKeysService } from "../api-keys/service.ts";
import {
  DatabaseError,
  ForbiddenError,
  RateLimitedError,
  RequestValidationError,
} from "../errors.ts";
import { addMillisecondsFrom, currentIso, currentTimeMillis, toIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import {
  generateDeviceCode,
  generateUserCode,
  hashDeviceAuthCode,
  normalizeUserCode,
} from "./token.ts";

const deviceAuthorizationTtlMs = 10 * 60 * 1000;
const deviceApiKeyTtlMs = 365 * 24 * 60 * 60 * 1000;
const pollIntervalSeconds = 5;
const globalPendingLimit = 30;
const fingerprintPendingLimit = 5;
const staleAuthorizationRetentionMs = 24 * 60 * 60 * 1000;

export type DeviceAuthorizationActivation = {
  readonly clientName: string;
  readonly expiresAt: string;
  readonly permissions: PermissionSet;
  readonly userCode: string;
  readonly userCodePreview: string;
};

export interface DeviceAuthorizationsService {
  readonly approve: (input: {
    readonly userCode: string;
    readonly userId: string;
  }) => Effect.Effect<void, DatabaseError | RequestValidationError>;
  readonly deny: (input: {
    readonly userCode: string;
  }) => Effect.Effect<void, DatabaseError | RequestValidationError>;
  readonly inspect: (
    userCode: string,
  ) => Effect.Effect<DeviceAuthorizationActivation | null, DatabaseError>;
  readonly start: (input: {
    readonly baseUrl: string;
    readonly clientName: string;
    readonly permissions: PermissionSet;
    readonly requesterFingerprint?: string;
  }) => Effect.Effect<
    DeviceAuthorizationStartResponse,
    DatabaseError | RateLimitedError | RequestValidationError
  >;
  readonly token: (
    deviceCode: string,
  ) => Effect.Effect<
    DeviceAuthorizationTokenResponse,
    DatabaseError | ForbiddenError | RequestValidationError
  >;
}

export const DeviceAuthorizations = Context.Service<DeviceAuthorizationsService>(
  "nusend/DeviceAuthorizations",
);

export function DeviceAuthorizationsLive(
  hashSecret: Redacted.Redacted<string>,
): Layer.Layer<
  DeviceAuthorizationsService,
  never,
  ApiKeysService | DatabaseService | IdGeneratorService
> {
  return Layer.effect(
    DeviceAuthorizations,
    Effect.gen(function* () {
      const apiKeys = yield* ApiKeys;
      const db = yield* Database;
      const ids = yield* IdGenerator;
      return makeDeviceAuthorizationsService({ apiKeys, db, hashSecret, ids });
    }),
  );
}

export function makeDeviceAuthorizationsService(input: {
  readonly apiKeys: ApiKeysService;
  readonly db: DatabaseService;
  readonly hashSecret: Redacted.Redacted<string>;
  readonly ids: IdGeneratorService;
}): DeviceAuthorizationsService {
  return {
    approve: ({ userCode, userId }) =>
      Effect.gen(function* () {
        const approvedAt = yield* currentIso;
        const updated = yield* input.db.get<{ id: string }>(
          "deviceAuth:approve",
          `UPDATE device_authorizations
           SET approved_by_user_id = $userId, approved_at = $approvedAt
           WHERE user_code_hash = $userCodeHash
             AND expires_at > $approvedAt
             AND approved_at IS NULL
             AND denied_at IS NULL
             AND consumed_at IS NULL
           RETURNING id;`,
          {
            approvedAt,
            userCodeHash: hashDeviceAuthCode(normalizeUserCode(userCode), input.hashSecret),
            userId,
          },
        );
        if (!updated) {
          return yield* Effect.fail(
            new RequestValidationError({
              message: "Device authorization code is invalid or expired.",
            }),
          );
        }
      }),
    deny: ({ userCode }) =>
      Effect.gen(function* () {
        const deniedAt = yield* currentIso;
        const updated = yield* input.db.get<{ id: string }>(
          "deviceAuth:deny",
          `UPDATE device_authorizations
           SET denied_at = $deniedAt
           WHERE user_code_hash = $userCodeHash
             AND expires_at > $deniedAt
             AND approved_at IS NULL
             AND denied_at IS NULL
             AND consumed_at IS NULL
           RETURNING id;`,
          {
            deniedAt,
            userCodeHash: hashDeviceAuthCode(normalizeUserCode(userCode), input.hashSecret),
          },
        );
        if (!updated) {
          return yield* Effect.fail(
            new RequestValidationError({ message: "Device authorization code is invalid." }),
          );
        }
      }),
    inspect: (userCode) =>
      Effect.gen(function* () {
        const normalizedUserCode = normalizeUserCode(userCode);
        const row = yield* input.db.get<DeviceAuthorizationRow & { user_code_preview: string }>(
          "deviceAuth:inspectByUserCode",
          `SELECT id, client_name, user_code_preview, requested_permissions_json, approved_by_user_id, approved_at, denied_at, consumed_at, expires_at, poll_count, last_poll_at
           FROM device_authorizations
           WHERE user_code_hash = $userCodeHash;`,
          { userCodeHash: hashDeviceAuthCode(normalizedUserCode, input.hashSecret) },
        );
        const now = yield* currentIso;
        if (!row || isExpired(row, now) || row.denied_at || row.consumed_at) return null;
        return {
          clientName: row.client_name,
          expiresAt: row.expires_at,
          permissions: yield* parseStoredPermissions(row.requested_permissions_json),
          userCode: normalizedUserCode,
          userCodePreview: row.user_code_preview,
        };
      }),
    start: ({ baseUrl, clientName, permissions, requesterFingerprint }) =>
      Effect.gen(function* () {
        const name = clientName.trim();
        if (name.length === 0) {
          return yield* Effect.fail(
            new RequestValidationError({ message: "clientName is required." }),
          );
        }
        const permissionResult = validatePermissionSet(permissions);
        if (!permissionResult.ok) {
          return yield* Effect.fail(
            new RequestValidationError({ message: permissionResult.message }),
          );
        }

        const deviceCode = generateDeviceCode();
        const userCode = generateUserCode();
        const nowMs = yield* currentTimeMillis;
        const nowIso = toIso(nowMs);
        const expiresAt = addMillisecondsFrom(nowMs, deviceAuthorizationTtlMs);
        const staleBefore = addMillisecondsFrom(nowMs, -staleAuthorizationRetentionMs);
        const requesterFingerprintHash = hashDeviceAuthCode(
          requesterFingerprint?.trim() || "direct",
          input.hashSecret,
        );
        const verificationUri = `${baseUrl.replace(/\/$/, "")}/cli/activate`;
        const verificationUriComplete = `${verificationUri}?code=${encodeURIComponent(userCode)}`;

        yield* input.db.run(
          "deviceAuth:cleanupExpired",
          "DELETE FROM device_authorizations WHERE expires_at < $staleBefore;",
          { staleBefore },
        );

        yield* input.db.transaction(
          Effect.gen(function* () {
            const globalPending = yield* input.db.get<{ count: number }>(
              "deviceAuth:countPending",
              `SELECT COUNT(*) AS count
               FROM device_authorizations
               WHERE expires_at > $now
                 AND denied_at IS NULL
                 AND consumed_at IS NULL;`,
              { now: nowIso },
            );
            if ((globalPending?.count ?? 0) >= globalPendingLimit) {
              return yield* Effect.fail(
                new RateLimitedError({ message: "Too many pending device authorizations." }),
              );
            }

            const fingerprintPending = yield* input.db.get<{ count: number }>(
              "deviceAuth:countPendingByFingerprint",
              `SELECT COUNT(*) AS count
               FROM device_authorizations
               WHERE expires_at > $now
                 AND denied_at IS NULL
                 AND consumed_at IS NULL
                 AND requester_fingerprint_hash = $requesterFingerprintHash;`,
              { now: nowIso, requesterFingerprintHash },
            );
            if ((fingerprintPending?.count ?? 0) >= fingerprintPendingLimit) {
              return yield* Effect.fail(
                new RateLimitedError({ message: "Too many pending device authorizations." }),
              );
            }

            yield* input.db.run(
              "deviceAuth:start",
              `INSERT INTO device_authorizations (id, device_code_hash, user_code_hash, user_code_preview, requested_permissions_json, client_name, expires_at, requester_fingerprint_hash, created_at)
               VALUES ($id, $deviceCodeHash, $userCodeHash, $userCodePreview, $requestedPermissionsJson, $clientName, $expiresAt, $requesterFingerprintHash, $createdAt);`,
              {
                clientName: name,
                createdAt: nowIso,
                deviceCodeHash: hashDeviceAuthCode(deviceCode, input.hashSecret),
                expiresAt,
                id: yield* input.ids.next,
                requestedPermissionsJson: JSON.stringify(permissions),
                requesterFingerprintHash,
                userCodeHash: hashDeviceAuthCode(normalizeUserCode(userCode), input.hashSecret),
                userCodePreview: maskUserCode(userCode),
              },
            );
          }),
        );

        return {
          deviceCode,
          expiresAt,
          intervalSeconds: pollIntervalSeconds,
          userCode,
          verificationUri,
          verificationUriComplete,
        };
      }),
    token: (deviceCode) =>
      Effect.gen(function* () {
        const deviceCodeHash = hashDeviceAuthCode(deviceCode, input.hashSecret);
        const preflightNow = yield* currentIso;
        const preflightRow = yield* findTokenRow(
          input.db,
          "deviceAuth:findByDeviceCodeForTokenPreflight",
          deviceCodeHash,
        );
        const preflightDecision = classifyTokenRow(preflightRow, preflightNow);
        if (preflightDecision.kind === "Outcome") return preflightDecision.outcome;

        // Only potentially mutating paths reserve the write connection. Re-read
        // under BEGIN IMMEDIATE so concurrent polls/approval/denial are linearized
        // before either recording a poll or creating and consuming an approved key.
        return yield* input.db.transaction(
          Effect.gen(function* () {
            const now = yield* currentIso;
            const row = yield* findTokenRow(
              input.db,
              "deviceAuth:findByDeviceCodeForTokenMutation",
              deviceCodeHash,
            );
            const decision = classifyTokenRow(row, now);
            if (decision.kind === "Outcome") return decision.outcome;

            if (!decision.row.approved_at || !decision.row.approved_by_user_id) {
              yield* input.db.run(
                "deviceAuth:recordPoll",
                `UPDATE device_authorizations SET poll_count = poll_count + 1, last_poll_at = $lastPollAt WHERE id = $id;`,
                { id: decision.row.id, lastPollAt: now },
              );
              return {
                intervalSeconds: pollIntervalSeconds,
                status: "authorization_pending",
              } satisfies DeviceAuthorizationTokenResponse;
            }

            const permissions = yield* parseStoredPermissions(
              decision.row.requested_permissions_json,
            );
            const apiKey = yield* input.apiKeys.create({
              actorPermissions: "owner",
              expiresAt: addMillisecondsFrom(Date.parse(now), deviceApiKeyTtlMs),
              name: `CLI: ${decision.row.client_name}`,
              permissions,
              userId: decision.row.approved_by_user_id,
            });
            yield* input.db.run(
              "deviceAuth:consume",
              `UPDATE device_authorizations SET consumed_at = $consumedAt WHERE id = $id;`,
              { consumedAt: now, id: decision.row.id },
            );

            return { apiKey, status: "approved" } satisfies DeviceAuthorizationTokenResponse;
          }),
        );
      }),
  };
}

function findTokenRow(
  db: DatabaseService,
  operation: string,
  deviceCodeHash: string,
): Effect.Effect<DeviceAuthorizationRow | null, DatabaseError> {
  return db.get<DeviceAuthorizationRow>(
    operation,
    `SELECT id, client_name, requested_permissions_json, approved_by_user_id, approved_at, denied_at, consumed_at, expires_at, poll_count, last_poll_at
     FROM device_authorizations
     WHERE device_code_hash = $deviceCodeHash;`,
    { deviceCodeHash },
  );
}

type TokenRowDecision =
  | { readonly kind: "Mutation"; readonly row: DeviceAuthorizationRow }
  | { readonly kind: "Outcome"; readonly outcome: DeviceAuthorizationTokenResponse };

function classifyTokenRow(row: DeviceAuthorizationRow | null, now: string): TokenRowDecision {
  if (!row) return { kind: "Outcome", outcome: { status: "invalid_grant" } };
  if (row.consumed_at || isExpired(row, now)) {
    return { kind: "Outcome", outcome: { status: "expired_token" } };
  }
  if (row.denied_at) return { kind: "Outcome", outcome: { status: "access_denied" } };

  // Approval always proceeds to the transactional re-read, regardless of prior
  // poll timing. Only a still-pending early poll is completed by this preflight.
  if (row.approved_at && row.approved_by_user_id) return { kind: "Mutation", row };
  // Use null presence (not epoch==0) so TestClock at t=0 still rate-limits polls.
  const tooSoon =
    row.last_poll_at !== null &&
    Date.parse(now) - Date.parse(row.last_poll_at) < pollIntervalSeconds * 1_000;
  return tooSoon
    ? {
        kind: "Outcome",
        outcome: { intervalSeconds: pollIntervalSeconds + 5, status: "slow_down" },
      }
    : { kind: "Mutation", row };
}

type DeviceAuthorizationRow = {
  readonly approved_at: string | null;
  readonly approved_by_user_id: string | null;
  readonly client_name: string;
  readonly consumed_at: string | null;
  readonly denied_at: string | null;
  readonly expires_at: string;
  readonly id: string;
  readonly last_poll_at: string | null;
  readonly poll_count: number;
  readonly requested_permissions_json: string;
};

function isExpired(row: DeviceAuthorizationRow, nowIso: string): boolean {
  return Date.parse(row.expires_at) <= Date.parse(nowIso);
}

// Stores only a masked display preview (e.g. AB••-••45) rather than the live user
// code, so a database-read adversary cannot see actionable approval codes.
function maskUserCode(code: string): string {
  const chars = [...code];
  const revealed = new Set([0, 1, chars.length - 2, chars.length - 1]);
  return chars.map((char, index) => (char === "-" || revealed.has(index) ? char : "•")).join("");
}

function parseStoredPermissions(value: string): Effect.Effect<PermissionSet, DatabaseError> {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(value) as PermissionSet,
      catch: (cause) =>
        new DatabaseError({ cause, operation: "deviceAuth:parseStoredPermissions" }),
    });
    const result = validatePermissionSet(parsed);
    if (!result.ok) {
      return yield* Effect.fail(
        new DatabaseError({
          cause: new Error(result.message),
          operation: "deviceAuth:parseStoredPermissions",
        }),
      );
    }
    return parsed;
  });
}
