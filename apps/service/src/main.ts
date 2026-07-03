import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { closeDatabase, openDatabase, pingDatabase } from "./db/index.ts";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const app = createApp({
  pingDatabase: () => pingDatabase(db),
});

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});

console.log(`Nusend service listening on http://${server.hostname}:${server.port}`);

function shutdown(): void {
  server.stop();
  closeDatabase(db);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
