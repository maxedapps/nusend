// In-process vitest test layers. The Database test layer runs on node:sqlite —
// same interface, same SQL text as the bun:sqlite production layer (parity is
// guarded by the driver-parity bun-scenario smoke).
import { DatabaseSync } from "node:sqlite";
import { Clock, Effect, Layer, ManagedRuntime, Option, Redacted, Result } from "effect";
import { TestClock } from "effect/testing";

import type { Hono } from "hono";

import { createApp } from "../app.ts";
import { readMigrationFiles } from "../db/migration-files.ts";
import { DatabaseError } from "../errors.ts";
import { Auth, type AuthService } from "../services/auth.ts";
import { Database, makeTransaction, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import {
  SesFeedbackConfigLive,
  type SesFeedbackConfig,
  type SesFeedbackConfigService,
} from "../ses-feedback/config.ts";
import { SnsVerificationError } from "../ses-feedback/errors.ts";
import { FakeSnsSubscriptionConfirmerLive } from "../ses-feedback/sns-confirmer.ts";
import {
  FakeSnsMessageVerifierLive,
  type SnsMessageVerifierService,
} from "../ses-feedback/sns-verifier.ts";
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
      Effect.map(makeService),
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
  // Ids drawn from a fixed list instead of the sequential generator.
  readonly ids?: readonly string[];
  readonly migrate?: boolean;
  readonly sesFeedback?: Option.Option<SesFeedbackConfig>;
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
    SesFeedbackConfigLive(options.sesFeedback ?? Option.none()),
    options.snsVerifier
      ? FakeSnsMessageVerifierLive(options.snsVerifier)
      : defaultSnsMessageVerifierLayer(),
    FakeSnsSubscriptionConfirmerLive(options.snsConfirmerCalls ?? []),
    UnsubscribeConfigLive(options.unsubscribe ?? Option.none()),
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

export function fakeSesFeedbackConfig(
  overrides: Partial<SesFeedbackConfig> = {},
): SesFeedbackConfig {
  return {
    topicArns: ["arn:aws:sns:us-east-1:123456789012:nusend-test"],
    ...overrides,
  };
}

export function fakeSesFeedbackConfigLayer(
  config: Option.Option<SesFeedbackConfig> = Option.some(fakeSesFeedbackConfig()),
): Layer.Layer<SesFeedbackConfigService> {
  return SesFeedbackConfigLive(config);
}

function defaultSnsMessageVerifierLayer(): Layer.Layer<SnsMessageVerifierService> {
  return FakeSnsMessageVerifierLive(() =>
    Effect.fail(new SnsVerificationError({ reason: "No fake SNS verifier configured." })),
  );
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

// Mirrors the fake Better Auth instance used by earlier scenario tests.
export function FakeAuthLive(behavior: FakeAuthBehavior = {}): Layer.Layer<AuthService> {
  return Layer.succeed(Auth)({
    getSession: () => Effect.succeed(behavior.session ? { session: behavior.session } : null),
    handler: async () => Response.json({ handled: true }),
    verifyApiKey: () =>
      Effect.succeed(
        behavior.apiKeyValid === false
          ? { key: null, valid: false }
          : {
              key: {
                id: "key_1",
                permissions: behavior.apiKeyPermissions ?? {},
                referenceId: "user_1",
              },
              valid: true,
            },
      ),
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

export type TestAppOptions = {
  readonly auth?: FakeAuthBehavior;
  readonly idPrefix?: string;
  readonly ids?: readonly string[];
  readonly migrate?: boolean;
  readonly sesFeedback?: Option.Option<SesFeedbackConfig>;
  readonly snsConfirmerCalls?: string[];
  readonly snsVerifier?: Parameters<typeof FakeSnsMessageVerifierLive>[0];
  readonly unsubscribe?: Option.Option<UnsubscribeConfig>;
};

export function makeTestRuntime(options: TestAppOptions = {}) {
  return ManagedRuntime.make(
    Layer.mergeAll(
      DatabaseNodeLive(":memory:", { migrate: options.migrate }),
      TestClock.layer(),
      options.ids ? listIdsLayer(options.ids) : sequentialIdsLayer(options.idPrefix ?? "id"),
      FakeAuthLive(options.auth),
      SesFeedbackConfigLive(options.sesFeedback ?? Option.none()),
      options.snsVerifier
        ? FakeSnsMessageVerifierLive(options.snsVerifier)
        : defaultSnsMessageVerifierLayer(),
      FakeSnsSubscriptionConfirmerLive(options.snsConfirmerCalls ?? []),
      UnsubscribeConfigLive(options.unsubscribe ?? Option.none()),
    ),
  );
}

export type TestRuntime = ReturnType<typeof makeTestRuntime>;

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
