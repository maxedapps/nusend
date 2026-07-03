import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ServiceConfig = {
  databasePath: string;
  host: string;
  port: number;
};

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const defaultDatabasePath = ".data/nusend.sqlite";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const host = env.NUSEND_HOST?.trim() || "0.0.0.0";
  const portValue = env.NUSEND_PORT?.trim() || env.PORT?.trim() || "3000";
  const databasePathValue = env.NUSEND_DB_PATH?.trim() || defaultDatabasePath;
  const port = Number(portValue);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("NUSEND_PORT must be an integer between 1 and 65535.");
  }

  if (databasePathValue.length === 0) {
    throw new Error("NUSEND_DB_PATH must not be empty.");
  }

  return {
    databasePath: resolveDatabasePath(databasePathValue),
    host,
    port,
  };
}

function resolveDatabasePath(databasePath: string): string {
  if (databasePath === ":memory:" || isAbsolute(databasePath)) return databasePath;

  return resolve(repoRoot, databasePath);
}
