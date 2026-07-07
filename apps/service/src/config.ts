import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AuthConfig = {
  baseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  secret: string;
  trustedOrigins: string[];
};

export type ServiceConfig = {
  auth: AuthConfig | null;
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
  const auth = loadAuthConfig(env);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("NUSEND_PORT must be an integer between 1 and 65535.");
  }

  if (databasePathValue.length === 0) {
    throw new Error("NUSEND_DB_PATH must not be empty.");
  }

  return {
    auth,
    databasePath: resolveDatabasePath(databasePathValue),
    host,
    port,
  };
}

export function requireAuthConfig(config: ServiceConfig): AuthConfig {
  if (!config.auth) {
    throw new Error(
      "Auth is not configured. Set BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET.",
    );
  }

  return config.auth;
}

function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  const baseUrl = env.BETTER_AUTH_URL?.trim();
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const rawTrustedOrigins = env.NUSEND_AUTH_TRUSTED_ORIGINS?.trim();
  const authValues = [secret, baseUrl, googleClientId, googleClientSecret, rawTrustedOrigins];

  if (authValues.every((value) => !value)) return null;

  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters when auth is configured.");
  }

  if (!baseUrl) {
    throw new Error("BETTER_AUTH_URL must be set when auth is configured.");
  }

  const parsedBaseUrl = parseAbsoluteUrl(baseUrl, "BETTER_AUTH_URL");

  if (env.NODE_ENV === "production" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL must use HTTPS in production.");
  }

  if (!googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID must be set when auth is configured.");
  }

  if (!googleClientSecret) {
    throw new Error("GOOGLE_CLIENT_SECRET must be set when auth is configured.");
  }

  return {
    baseUrl: parsedBaseUrl.toString().replace(/\/$/, ""),
    googleClientId,
    googleClientSecret,
    secret,
    trustedOrigins: parseTrustedOrigins(rawTrustedOrigins, parsedBaseUrl.origin),
  };
}

function parseAbsoluteUrl(value: string, envName: string): URL {
  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid protocol");
    }

    return url;
  } catch {
    throw new Error(`${envName} must be an absolute http(s) URL.`);
  }
}

function parseTrustedOrigins(value: string | undefined, fallbackOrigin: string): string[] {
  if (!value) return [fallbackOrigin];

  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => parseAbsoluteUrl(origin, "NUSEND_AUTH_TRUSTED_ORIGINS").origin);

  return [...new Set(origins.length > 0 ? origins : [fallbackOrigin])];
}

function resolveDatabasePath(databasePath: string): string {
  if (databasePath === ":memory:" || isAbsolute(databasePath)) return databasePath;

  return resolve(repoRoot, databasePath);
}
