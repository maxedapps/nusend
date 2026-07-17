// Service entrypoint — the composition boundary: read config, build the layer
// stack, create the ManagedRuntime, serve. Shutdown stops the server and then
// disposes the runtime (which closes the database via the layer finalizer).
import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";

import { createApp } from "./app.ts";
import { assertMigrationsUpToDate, describeStartupMigrationFailure } from "./db/migration-check.ts";
import { ApiKeysLive } from "./api-keys/service.ts";
import { DeviceAuthorizationsLive } from "./device-auth/service.ts";
import { deploymentConfig } from "./config.ts";
import { JsonLoggerLive } from "./observability/effect-logger.ts";
import { AuthLive } from "./services/auth-live.ts";
import { Database } from "./services/database.ts";
import { DatabaseBunLive } from "./services/database-bun.ts";
import { IdGeneratorLive } from "./services/ids.ts";
import { SesAdminLive } from "./aws/ses-admin.ts";
import { SnsAdminLive } from "./aws/sns-admin.ts";
import { SesOperationsConfigLive } from "./ses/config.ts";
import { SnsSubscriptionConfirmerLive } from "./ses/sns-confirmer.ts";
import { SnsMessageVerifierLive } from "./ses/sns-verifier.ts";
import { UnsubscribeConfigLive } from "./unsubscribe/config.ts";

const configProvider = ConfigProvider.fromEnv();
const deployment = await Effect.runPromise(
  deploymentConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configProvider)),
).catch((error: unknown) => {
  console.error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
  return process.exit(1);
});
const config = deployment.service;

if (Option.isNone(config.auth)) {
  console.error(
    "Auth is not configured. Set BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET.",
  );
  process.exit(1);
}

const unsubscribe = deployment.unsubscribe;
const sesOperations = deployment.sesOperations;

// Reusing the same dbLayer reference is memoized to ONE database acquisition;
// AuthLive consumes the raw SqliteHandle it provides.
const dbLayer = DatabaseBunLive(config.databasePath);
const idLayer = IdGeneratorLive;
const apiKeysLayer = ApiKeysLive(Option.getOrThrow(config.apiKeyHashSecret)).pipe(
  Layer.provide(Layer.mergeAll(dbLayer, idLayer)),
);
const deviceAuthorizationsLayer = DeviceAuthorizationsLive(
  Option.getOrThrow(config.apiKeyHashSecret),
).pipe(Layer.provide(Layer.mergeAll(dbLayer, idLayer, apiKeysLayer)));
const appLayer = Layer.mergeAll(
  dbLayer,
  idLayer,
  SesOperationsConfigLive(sesOperations),
  SnsMessageVerifierLive,
  SnsSubscriptionConfirmerLive,
  SesAdminLive.pipe(Layer.provide(SesOperationsConfigLive(sesOperations))),
  SnsAdminLive.pipe(Layer.provide(SesOperationsConfigLive(sesOperations))),
  UnsubscribeConfigLive(unsubscribe),
  apiKeysLayer,
  deviceAuthorizationsLayer,
  AuthLive(config.auth.value).pipe(Layer.provide(dbLayer)),
  JsonLoggerLive,
);
const runtime = ManagedRuntime.make(appLayer);

// Fail fast: force layer construction (opens the database) and require a
// healthy connection before serving.
try {
  const alive = await runtime.runPromise(Effect.flatMap(Database, (db) => db.ping));
  if (!alive) {
    console.error("Failed to start: database ping failed.");
    await runtime.dispose();
    process.exit(1);
  }
} catch (error) {
  console.error(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
  await runtime.dispose();
  process.exit(1);
}

// Fail fast on a stale/empty schema: refuse to serve if migrations are pending,
// missing, or checksum-drifted rather than 500ing every route with "no such table".
const migrationCheck = await runtime.runPromiseExit(assertMigrationsUpToDate());
if (Exit.isFailure(migrationCheck)) {
  console.error(`Failed to start: ${describeStartupMigrationFailure(migrationCheck.cause)}`);
  await runtime.dispose();
  process.exit(1);
}

// The canonical public origin from BETTER_AUTH_URL, so same-origin checks and
// verification URLs are correct behind a TLS-terminating proxy.
const publicOrigin = new URL(config.auth.value.baseUrl).origin;
const app = createApp({ publicOrigin, runtime });

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host,
  // Global backstop against unbounded pre-auth bodies (e.g. /api/auth/*,
  // /cli/activate have no per-route bodyLimit). Above the 1 MB mailing limit.
  maxRequestBodySize: 2 * 1024 * 1024,
  port: config.port,
});

console.log(`Nusend service listening on http://${server.hostname}:${server.port}`);

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // Drain in-flight requests before disposing the runtime (which closes the
  // database); otherwise SIGTERM on every deploy/restart can fail active
  // requests with closed-database errors. Bound the wait so a stuck request
  // cannot block shutdown forever.
  await Promise.race([
    server.stop(),
    new Promise((resolve) => setTimeout(resolve, 10_000)).then(() => server.stop(true)),
  ]);
  await runtime.dispose();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
