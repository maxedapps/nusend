// In-process vitest test layers. The Database test layer runs on node:sqlite —
// same interface, same SQL text as the bun:sqlite production layer (parity is
// guarded by the driver-parity bun-scenario smoke).
import { DatabaseSync } from "node:sqlite";
import {
  Clock,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Redacted,
  Result,
  Semaphore,
} from "effect";
import { TestClock } from "effect/testing";

import type { Hono } from "hono";

import { createApp } from "../app.ts";
import { ApiKeys, ApiKeysLive, type ApiKeysService } from "../api-keys/service.ts";
import {
  DeviceAuthorizations,
  DeviceAuthorizationsLive,
  type DeviceAuthorizationsService,
} from "../device-auth/service.ts";
import { readMigrationFiles } from "../db/migration-files.ts";
import { DatabaseError } from "../errors.ts";
import { Auth, type AuthService } from "../services/auth.ts";
import {
  Database,
  makeTransaction,
  serializeDatabaseService,
  type DatabaseService,
} from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import { AwsAdminError } from "../aws/errors.ts";
import { FakeSesAdminLive, type SesAdminService } from "../aws/ses-admin.ts";
import { FakeSnsAdminLive, type SnsAdminService } from "../aws/sns-admin.ts";
import {
  SesOperationsConfigLive,
  type SesOperationsConfig,
  type SesOperationsConfigService,
} from "../ses/config.ts";
import { SnsVerificationError } from "../ses/errors.ts";
import { FakeSnsSubscriptionConfirmerLive } from "../ses/sns-confirmer.ts";
import { FakeSnsMessageVerifierLive, type SnsMessageVerifierService } from "../ses/sns-verifier.ts";
import {
  UnsubscribeConfigLive,
  type UnsubscribeConfig,
  type UnsubscribeConfigService,
} from "../unsubscribe/config.ts";

export type DatabaseNodeOptions = {
  readonly migrate?: boolean;
};

export function DatabaseNodeLive(
  databasePath: string,
  options: DatabaseNodeOptions = {},
): Layer.Layer<DatabaseService> {
  return Layer.effect(
    Database,
    Effect.acquireRelease(
      // Matches the bun layer's PRAGMA foreign_keys = ON. Migrations run after the
      // close finalizer is registered so a failing migration cannot leak the handle.
      Effect.sync(() => new DatabaseSync(databasePath, { enableForeignKeyConstraints: true })),
      (db) => Effect.sync(() => db.close()),
    ).pipe(
      Effect.tap((db) =>
        Effect.sync(() => (options.migrate === false ? undefined : applyMigrations(db))),
      ),
      Effect.map((db) => serializeDatabaseService(makeService(db), Semaphore.makeUnsafe(1))),
    ),
  );
}

function applyMigrations(db: DatabaseSync): void {
  for (const parsed of readMigrationFiles()) {
    db.exec(Result.getOrThrow(parsed).upSql);
  }
}

function makeService(db: DatabaseSync): DatabaseService {
  const exec: DatabaseService["exec"] = (operation, sql) =>
    Effect.try({
      try: () => {
        db.exec(sql);
      },
      catch: (cause) => new DatabaseError({ cause, operation }),
    });

  return {
    all: (operation, sql, params) =>
      Effect.try({
        try: () => db.prepare(sql).all(params ?? {}) as never,
        catch: (cause) => new DatabaseError({ cause, operation }),
      }),
    exec,
    get: (operation, sql, params) =>
      Effect.try({
        // node:sqlite returns undefined for no-row get; the service contract is T | null.
        try: () => (db.prepare(sql).get(params ?? {}) ?? null) as never,
        catch: (cause) => new DatabaseError({ cause, operation }),
      }),
    ping: Effect.sync(() => {
      try {
        db.prepare("SELECT 1 AS ok;").get();
        return true;
      } catch {
        return false;
      }
    }),
    run: (operation, sql, params) =>
      Effect.try({
        try: () => {
          db.prepare(sql).run(params ?? {});
        },
        catch: (cause) => new DatabaseError({ cause, operation }),
      }),
    transaction: makeTransaction(exec),
  };
}

export function sequentialIdsLayer(prefix: string): Layer.Layer<IdGeneratorService> {
  return Layer.sync(IdGenerator)(() => {
    let counter = 0;

    return {
      next: Effect.sync(() => {
        counter += 1;
        return `${prefix}_${counter}`;
      }),
    };
  });
}

// A Clock whose reads walk through the given instants one by one and FAIL on
// any read beyond the list. Pins exactly how many times production code reads
// the clock — unlike TestClock, which only moves when a test explicitly sets it.
export function steppingClockLayer(isoTimes: readonly string[]): Layer.Layer<never> {
  let index = 0;
  const nextMillis = (): number => {
    const value = isoTimes[index];
    if (value === undefined) {
      throw new Error(
        `steppingClockLayer: unexpected clock read #${index + 1} (only ${isoTimes.length} instants provided)`,
      );
    }
    index += 1;
    return Date.parse(value);
  };

  return Layer.succeed(Clock.Clock)({
    currentTimeMillis: Effect.sync(nextMillis),
    currentTimeMillisUnsafe: nextMillis,
    currentTimeNanos: Effect.sync(() => BigInt(nextMillis()) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(nextMillis()) * 1_000_000n,
    sleep: () => Effect.void,
  });
}

export type TestLayerOptions = {
  readonly idPrefix?: string;
  readonly logSink?: CapturedLog[];
  // Ids drawn from a fixed list instead of the sequential generator.
  readonly ids?: readonly string[];
  readonly migrate?: boolean;
  readonly sesOperations?: SesOperationsConfig;
  readonly sesAdmin?: SesAdminService;
  readonly snsAdmin?: SnsAdminService;
  readonly snsConfirmerCalls?: string[];
  readonly snsVerifier?: Parameters<typeof FakeSnsMessageVerifierLive>[0];
  readonly unsubscribe?: Option.Option<UnsubscribeConfig>;
  // Replaces the default TestClock (e.g. steppingClockLayer). Programs using
  // TestClock.setTime require the default.
  readonly clock?: Layer.Layer<never>;
};

export function testLayer(options: TestLayerOptions = {}) {
  return Layer.mergeAll(
    DatabaseNodeLive(":memory:", { migrate: options.migrate }),
    options.clock ?? TestClock.layer(),
    options.ids ? listIdsLayer(options.ids) : sequentialIdsLayer(options.idPrefix ?? "id"),
    SesOperationsConfigLive(options.sesOperations ?? fakeSesOperationsConfig()),
    options.snsVerifier
      ? FakeSnsMessageVerifierLive(options.snsVerifier)
      : defaultSnsMessageVerifierLayer(),
    FakeSnsSubscriptionConfirmerLive(options.snsConfirmerCalls ?? []),
    FakeSesAdminLive(options.sesAdmin ?? defaultSesAdmin()),
    FakeSnsAdminLive(options.snsAdmin ?? defaultSnsAdmin()),
    UnsubscribeConfigLive(options.unsubscribe ?? Option.none()),
    ...(options.logSink
      ? [Logger.layer([Logger.make((entry) => options.logSink!.push(entry))])]
      : []),
  );
}

export type TestServices =
  ReturnType<typeof testLayer> extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never;

// Each call builds a fresh layer stack (fresh :memory: database) — a multi-step
// scenario is therefore one Effect program, advancing time via TestClock.setTime.
export function runTest<A, E>(
  effect: Effect.Effect<A, E, TestServices>,
  options: TestLayerOptions = {},
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(testLayer(options))));
}

export function fakeSesOperationsConfig(
  overrides: Partial<SesOperationsConfig> = {},
): SesOperationsConfig {
  return {
    awsRegion: Option.some("us-east-1"),
    configIssues: [],
    feedbackTopicArns: ["arn:aws:sns:us-east-1:123456789012:nusend-test"],
    fromEmail: Option.some("sender@example.com"),
    marketingConfigurationSet: Option.some("marketing-set"),
    publicBaseUrl: Option.some("https://mail.example.com"),
    requestTimeoutMs: 30000,
    trackingCustomRedirectDomain: Option.none(),
    trackingEvents: [],
    transactionalConfigurationSet: Option.some("transactional-set"),
    unsubscribeSecretConfigured: true,
    workerBatchSize: 1,
    workerLeaseSeconds: 300,
    workerPollMs: 5000,
    ...overrides,
  };
}

export function fakeSesOperationsConfigLayer(
  config: SesOperationsConfig = fakeSesOperationsConfig(),
): Layer.Layer<SesOperationsConfigService> {
  return SesOperationsConfigLive(config);
}

function defaultSnsMessageVerifierLayer(): Layer.Layer<SnsMessageVerifierService> {
  return FakeSnsMessageVerifierLive(() =>
    Effect.fail(new SnsVerificationError({ reason: "No fake SNS verifier configured." })),
  );
}

function defaultSesAdmin(): SesAdminService {
  const failure = () =>
    Effect.fail(new AwsAdminError({ kind: "missing_credentials", operation: "fake-ses-admin" }));
  return {
    getAccount: failure,
    getConfigurationSet: failure,
    getConfigurationSetEventDestinations: failure,
    getEmailIdentity: failure,
  };
}

function defaultSnsAdmin(): SnsAdminService {
  const failure = () =>
    Effect.fail(new AwsAdminError({ kind: "missing_credentials", operation: "fake-sns-admin" }));
  return {
    getTopicAttributes: failure,
    listSubscriptionsByTopic: failure,
  };
}

export function fakeUnsubscribeConfig(
  overrides: Partial<UnsubscribeConfig> = {},
): UnsubscribeConfig {
  return {
    currentSecret: Redacted.make("current-unsubscribe-secret-value-32"),
    previousSecret: null,
    publicBaseUrl: "https://unsubscribe.example.com",
    ...overrides,
  };
}

export function fakeUnsubscribeConfigLayer(
  config: Option.Option<UnsubscribeConfig> = Option.some(fakeUnsubscribeConfig()),
): Layer.Layer<UnsubscribeConfigService> {
  return UnsubscribeConfigLive(config);
}

export type FakeAuthBehavior = {
  readonly session?: { userId: string } | null;
  readonly apiKeyValid?: boolean;
  readonly apiKeyPermissions?: Record<string, string[]>;
};

export function FakeDeviceAuthorizationsLive(): Layer.Layer<DeviceAuthorizationsService> {
  return Layer.succeed(DeviceAuthorizations)({
    approve: () => Effect.die("FakeDeviceAuthorizationsLive does not implement approve."),
    deny: () => Effect.die("FakeDeviceAuthorizationsLive does not implement deny."),
    inspect: () => Effect.die("FakeDeviceAuthorizationsLive does not implement inspect."),
    start: () => Effect.die("FakeDeviceAuthorizationsLive does not implement start."),
    token: () => Effect.die("FakeDeviceAuthorizationsLive does not implement token."),
  });
}

export function FakeApiKeysLive(behavior: FakeAuthBehavior = {}): Layer.Layer<ApiKeysService> {
  return Layer.succeed(ApiKeys)({
    create: () => Effect.die("FakeApiKeysLive does not implement create."),
    list: () => Effect.die("FakeApiKeysLive does not implement list."),
    revoke: () => Effect.die("FakeApiKeysLive does not implement revoke."),
    rotate: () => Effect.die("FakeApiKeysLive does not implement rotate."),
    verify: () =>
      Effect.succeed(
        behavior.apiKeyValid === false
          ? { key: null, valid: false }
          : {
              key: {
                id: "key_1",
                permissions: behavior.apiKeyPermissions ?? {},
                userId: "user_1",
              },
              valid: true,
            },
      ),
  });
}

// Mirrors the fake Better Auth instance used by earlier scenario tests.
export function FakeAuthLive(behavior: FakeAuthBehavior = {}): Layer.Layer<AuthService> {
  return Layer.succeed(Auth)({
    getSession: () => Effect.succeed(behavior.session ? { session: behavior.session } : null),
    handler: async () => Response.json({ handled: true }),
  });
}

// Ids drawn from a fixed list (then a constant fallback) — for scenarios that
// need deliberate id collisions.
export function listIdsLayer(values: readonly string[]): Layer.Layer<IdGeneratorService> {
  return Layer.sync(IdGenerator)(() => {
    let index = 0;

    return {
      next: Effect.sync(() => {
        const value = values[index] ?? "fallback";
        index += 1;
        return value;
      }),
    };
  });
}

export type CapturedLog = Logger.Options<unknown>;

export type TestAppOptions = {
  readonly auth?: FakeAuthBehavior;
  readonly logSink?: CapturedLog[];
  readonly idPrefix?: string;
  readonly ids?: readonly string[];
  readonly migrate?: boolean;
  readonly realApiKeys?: boolean;
  readonly realDeviceAuthorizations?: boolean;
  readonly sesOperations?: SesOperationsConfig;
  readonly sesAdmin?: SesAdminService;
  readonly snsAdmin?: SnsAdminService;
  readonly snsConfirmerCalls?: string[];
  readonly snsVerifier?: Parameters<typeof FakeSnsMessageVerifierLive>[0];
  readonly unsubscribe?: Option.Option<UnsubscribeConfig>;
};

export function makeTestRuntime(options: TestAppOptions = {}) {
  const databaseLayer = DatabaseNodeLive(":memory:", { migrate: options.migrate });
  const idsLayer = options.ids
    ? listIdsLayer(options.ids)
    : sequentialIdsLayer(options.idPrefix ?? "id");
  const apiKeysLayer = options.realApiKeys
    ? ApiKeysLive(Redacted.make("test-api-key-hash-secret-32-value")).pipe(
        Layer.provide(Layer.mergeAll(databaseLayer, idsLayer)),
      )
    : FakeApiKeysLive(options.auth);
  const deviceAuthorizationsLayer = options.realDeviceAuthorizations
    ? DeviceAuthorizationsLive(Redacted.make("test-device-auth-secret-32-value")).pipe(
        Layer.provide(Layer.mergeAll(databaseLayer, idsLayer, apiKeysLayer)),
      )
    : FakeDeviceAuthorizationsLive();

  return ManagedRuntime.make(
    Layer.mergeAll(
      databaseLayer,
      TestClock.layer(),
      idsLayer,
      FakeAuthLive(options.auth),
      apiKeysLayer,
      deviceAuthorizationsLayer,
      SesOperationsConfigLive(options.sesOperations ?? fakeSesOperationsConfig()),
      options.snsVerifier
        ? FakeSnsMessageVerifierLive(options.snsVerifier)
        : defaultSnsMessageVerifierLayer(),
      FakeSnsSubscriptionConfirmerLive(options.snsConfirmerCalls ?? []),
      FakeSesAdminLive(options.sesAdmin ?? defaultSesAdmin()),
      FakeSnsAdminLive(options.snsAdmin ?? defaultSnsAdmin()),
      UnsubscribeConfigLive(options.unsubscribe ?? Option.none()),
      ...(options.logSink
        ? [Logger.layer([Logger.make((entry) => options.logSink!.push(entry))])]
        : []),
    ),
  );
}

export type TestRuntime = ReturnType<typeof makeTestRuntime>;

export async function runTestSql(
  runtime: TestRuntime,
  operation: string,
  sql: string,
  params?: Record<string, string | number | null>,
): Promise<void> {
  await runtime.runPromise(Effect.flatMap(Database, (db) => db.run(operation, sql, params)));
}

export async function queryTestDatabase<T>(
  runtime: TestRuntime,
  operation: string,
  sql: string,
  params?: Record<string, string | number | null>,
): Promise<readonly T[]> {
  return await runtime.runPromise(
    Effect.flatMap(Database, (db) => db.all<T>(operation, sql, params)),
  );
}

export async function seedTestUser(
  runtime: TestRuntime,
  input: { readonly email?: string; readonly id?: string; readonly name?: string } = {},
): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "testing:seedUser",
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES ($id, $name, $email, 1, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');`,
        {
          email: input.email ?? "max@example.com",
          id: input.id ?? "user_1",
          name: input.name ?? "Max",
        },
      );
    }),
  );
}

// The real Hono app wired to an in-process runtime (node:sqlite + fake auth).
// The runtime is passed to `run` so tests can seed and assert database state.
export async function withTestApp<T>(
  options: TestAppOptions,
  run: (app: Hono, runtime: TestRuntime) => Promise<T>,
): Promise<T> {
  const runtime = makeTestRuntime(options);

  try {
    return await run(createApp({ runtime }), runtime);
  } finally {
    await runtime.dispose();
  }
}
