// Effect Config definitions for the service. Values are read through the ambient
// ConfigProvider: production boundaries provide ConfigProvider.fromEnv(), tests
// provide ConfigProvider.fromUnknown(fixture).
//
// Env semantics ported exactly from the pre-Effect config: empty/whitespace-only
// values count as missing; the port fallback is presence-based (an invalid
// NUSEND_PORT fails hard instead of falling through to PORT or the default); the
// auth group is all-or-nothing with a hard failure on partial configuration.
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, ConfigProvider, Effect, Option, Redacted } from "effect";

export type AuthConfig = {
  baseUrl: string;
  googleClientId: string;
  googleClientSecret: Redacted.Redacted<string>;
  secret: Redacted.Redacted<string>;
  trustedOrigins: string[];
};

export type ServiceConfig = {
  auth: Option.Option<AuthConfig>;
  databasePath: string;
  host: string;
  port: number;
};

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const defaultDatabasePath = ".data/nusend.sqlite";

const requiredAuthVariables = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

// Reads a variable with today's `env.X?.trim() || fallback` presence semantics:
// unset, empty, and whitespace-only all become None.
function trimmedOption(name: string): Config.Config<Option.Option<string>> {
  return Config.option(Config.string(name)).pipe(
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed.length === 0 ? Option.none() : Option.some(trimmed);
      }),
    ),
  );
}

function configFailure(message: string): Config.Config<never> {
  return Config.fail(new ConfigProvider.SourceError({ message }));
}

function parseAbsoluteUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function resolveDatabasePath(databasePath: string): string {
  if (databasePath === ":memory:" || isAbsolute(databasePath)) return databasePath;

  return resolve(repoRoot, databasePath);
}

const authConfig: Effect.Effect<Option.Option<AuthConfig>, Config.ConfigError> = Effect.gen(
  function* () {
    const secret = yield* trimmedOption("BETTER_AUTH_SECRET");
    const baseUrl = yield* trimmedOption("BETTER_AUTH_URL");
    const googleClientId = yield* trimmedOption("GOOGLE_CLIENT_ID");
    const googleClientSecret = yield* trimmedOption("GOOGLE_CLIENT_SECRET");
    const trustedOrigins = yield* trimmedOption("NUSEND_AUTH_TRUSTED_ORIGINS");
    const nodeEnv = yield* Config.option(Config.string("NODE_ENV"));

    const allValues = [secret, baseUrl, googleClientId, googleClientSecret, trustedOrigins];
    if (allValues.every(Option.isNone)) return Option.none<AuthConfig>();

    const byName = {
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: baseUrl,
      GOOGLE_CLIENT_ID: googleClientId,
      GOOGLE_CLIENT_SECRET: googleClientSecret,
    };
    const missing = requiredAuthVariables.filter((name) => Option.isNone(byName[name]));
    if (missing.length > 0) {
      return yield* configFailure(
        `Auth is partially configured. Missing: ${missing.join(", ")} (required when any auth variable is set).`,
      );
    }

    const secretValue = Option.getOrThrow(secret);
    if (secretValue.length < 32) {
      return yield* configFailure(
        "BETTER_AUTH_SECRET must be at least 32 characters when auth is configured.",
      );
    }

    const parsedBaseUrl = parseAbsoluteUrl(Option.getOrThrow(baseUrl));
    if (!parsedBaseUrl) {
      return yield* configFailure("BETTER_AUTH_URL must be an absolute http(s) URL.");
    }

    if (
      Option.getOrElse(nodeEnv, () => "") === "production" &&
      parsedBaseUrl.protocol !== "https:"
    ) {
      return yield* configFailure("BETTER_AUTH_URL must use HTTPS in production.");
    }

    const origins: string[] = [];
    if (Option.isSome(trustedOrigins)) {
      for (const raw of trustedOrigins.value.split(",")) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;

        const url = parseAbsoluteUrl(trimmed);
        if (!url) {
          return yield* configFailure(
            "NUSEND_AUTH_TRUSTED_ORIGINS must be a comma-separated list of absolute http(s) URLs.",
          );
        }
        origins.push(url.origin);
      }
    }

    return Option.some<AuthConfig>({
      baseUrl: parsedBaseUrl.toString().replace(/\/$/, ""),
      googleClientId: Option.getOrThrow(googleClientId),
      googleClientSecret: Redacted.make(Option.getOrThrow(googleClientSecret)),
      secret: Redacted.make(secretValue),
      trustedOrigins: [...new Set(origins.length > 0 ? origins : [parsedBaseUrl.origin])],
    });
  },
);

export const serviceConfig: Effect.Effect<ServiceConfig, Config.ConfigError> = Effect.gen(
  function* () {
    const host = Option.getOrElse(yield* trimmedOption("NUSEND_HOST"), () => "0.0.0.0");

    const nusendPort = yield* trimmedOption("NUSEND_PORT");
    const fallbackPort = yield* trimmedOption("PORT");
    const portValue = Option.getOrElse(
      Option.orElse(nusendPort, () => fallbackPort),
      () => "3000",
    );
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return yield* configFailure("NUSEND_PORT must be an integer between 1 and 65535.");
    }

    const databasePath = resolveDatabasePath(
      Option.getOrElse(yield* trimmedOption("NUSEND_DB_PATH"), () => defaultDatabasePath),
    );

    return {
      auth: yield* authConfig,
      databasePath,
      host,
      port,
    };
  },
);
