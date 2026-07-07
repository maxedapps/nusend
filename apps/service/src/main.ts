// Service entrypoint — the composition boundary: read config, build the layer
// stack, create the ManagedRuntime, serve. Shutdown stops the server and then
// disposes the runtime (which closes the database via the layer finalizer).
import { ConfigProvider, Effect, Layer, ManagedRuntime, Option } from "effect";

import { createApp } from "./app.ts";
import { serviceConfig } from "./config.ts";
import { AuthLive } from "./services/auth-live.ts";
import { Database } from "./services/database.ts";
import { DatabaseBunLive } from "./services/database-bun.ts";
import { IdGeneratorLive } from "./services/ids.ts";

const config = await Effect.runPromise(
  serviceConfig.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
  ),
).catch((error: unknown) => {
  console.error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
  return process.exit(1);
});

if (Option.isNone(config.auth)) {
  console.error(
    "Auth is not configured. Set BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET.",
  );
  process.exit(1);
}

// Reusing the same dbLayer reference is memoized to ONE database acquisition;
// AuthLive consumes the raw SqliteHandle it provides.
const dbLayer = DatabaseBunLive(config.databasePath);
const appLayer = Layer.mergeAll(
  dbLayer,
  IdGeneratorLive,
  AuthLive(config.auth.value).pipe(Layer.provide(dbLayer)),
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

const app = createApp({ runtime });

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});

console.log(`Nusend service listening on http://${server.hostname}:${server.port}`);

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  server.stop();
  await runtime.dispose();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
