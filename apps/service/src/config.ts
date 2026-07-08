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

import type { UnsubscribeConfig as ParsedUnsubscribeConfig } from "./unsubscribe/config.ts";

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

export type SendingConfig = {
  fromEmail: string;
  marketingConfigurationSet: string | null;
  region: string;
  requestTimeoutMs: number;
  transactionalConfigurationSet: string | null;
  workerBatchSize: number;
  workerLeaseSeconds: number;
};

export type { ParsedUnsubscribeConfig as UnsubscribeConfig };

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const defaultDatabasePath = ".data/nusend.sqlite";
const sendWorkerLeaseMarginMs = 10_000;

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

    const isProduction = Option.getOrElse(nodeEnv, () => "") === "production";

    if (isProduction && parsedBaseUrl.protocol !== "https:") {
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
        if (isProduction && url.protocol !== "https:") {
          return yield* configFailure(
            "NUSEND_AUTH_TRUSTED_ORIGINS must use HTTPS origins in production.",
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

export const unsubscribeConfig: Effect.Effect<
  Option.Option<ParsedUnsubscribeConfig>,
  Config.ConfigError
> = Effect.gen(function* () {
  const publicBaseUrl = yield* trimmedOption("NUSEND_PUBLIC_BASE_URL");
  const currentSecret = yield* trimmedOption("NUSEND_UNSUBSCRIBE_SECRET");
  const previousSecret = yield* trimmedOption("NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET");

  if ([publicBaseUrl, currentSecret, previousSecret].every(Option.isNone)) {
    return Option.none<ParsedUnsubscribeConfig>();
  }

  const missing: string[] = [];
  if (Option.isNone(publicBaseUrl)) missing.push("NUSEND_PUBLIC_BASE_URL");
  if (Option.isNone(currentSecret)) missing.push("NUSEND_UNSUBSCRIBE_SECRET");
  if (missing.length > 0) {
    return yield* configFailure(
      `Unsubscribe is partially configured. Missing: ${missing.join(", ")}.`,
    );
  }

  const parsedBaseUrl = parseAbsoluteUrl(Option.getOrThrow(publicBaseUrl));
  if (!parsedBaseUrl || parsedBaseUrl.protocol !== "https:") {
    return yield* configFailure("NUSEND_PUBLIC_BASE_URL must be an absolute HTTPS URL.");
  }
  if (parsedBaseUrl.search !== "" || parsedBaseUrl.hash !== "") {
    return yield* configFailure(
      "NUSEND_PUBLIC_BASE_URL must not include a query string or fragment.",
    );
  }
  if (/[&'"<>]/.test(Option.getOrThrow(publicBaseUrl))) {
    return yield* configFailure(
      "NUSEND_PUBLIC_BASE_URL must not include HTML-escapable characters.",
    );
  }

  const current = Option.getOrThrow(currentSecret);
  if (current.length < 32) {
    return yield* configFailure("NUSEND_UNSUBSCRIBE_SECRET must be at least 32 characters.");
  }

  let previous: Redacted.Redacted<string> | null = null;
  if (Option.isSome(previousSecret)) {
    if (previousSecret.value.length < 32) {
      return yield* configFailure(
        "NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET must be at least 32 characters.",
      );
    }
    if (previousSecret.value === current) {
      return yield* configFailure(
        "NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET must differ from NUSEND_UNSUBSCRIBE_SECRET.",
      );
    }
    previous = Redacted.make(previousSecret.value);
  }

  return Option.some<ParsedUnsubscribeConfig>({
    currentSecret: Redacted.make(current),
    previousSecret: previous,
    publicBaseUrl: parsedBaseUrl.toString().replace(/\/$/, ""),
  });
});

export const sendingConfig: Effect.Effect<SendingConfig, Config.ConfigError> = Effect.gen(
  function* () {
    const fromEmailOption = yield* trimmedOption("NUSEND_SES_FROM_EMAIL");
    if (Option.isNone(fromEmailOption)) {
      return yield* configFailure("NUSEND_SES_FROM_EMAIL is required.");
    }
    const regionOption = yield* trimmedOption("AWS_REGION");
    if (Option.isNone(regionOption)) {
      return yield* configFailure("AWS_REGION is required.");
    }
    const fromEmail = fromEmailOption.value;
    const region = regionOption.value;
    const transactionalConfigurationSet = Option.getOrNull(
      yield* trimmedOption("NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET"),
    );
    const marketingConfigurationSet = Option.getOrNull(
      yield* trimmedOption("NUSEND_SES_MARKETING_CONFIGURATION_SET"),
    );
    const requestTimeoutMsValue = Option.getOrElse(
      yield* trimmedOption("NUSEND_SES_REQUEST_TIMEOUT_MS"),
      () => "30000",
    );
    const requestTimeoutMs = Number(requestTimeoutMsValue);
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      return yield* configFailure("NUSEND_SES_REQUEST_TIMEOUT_MS must be a positive integer.");
    }

    const workerLeaseSecondsValue = Option.getOrElse(
      yield* trimmedOption("NUSEND_SEND_WORKER_LEASE_SECONDS"),
      () => "300",
    );
    const workerLeaseSeconds = Number(workerLeaseSecondsValue);
    if (!Number.isInteger(workerLeaseSeconds) || workerLeaseSeconds < 1) {
      return yield* configFailure("NUSEND_SEND_WORKER_LEASE_SECONDS must be a positive integer.");
    }

    const workerBatchSizeValue = Option.getOrElse(
      yield* trimmedOption("NUSEND_SEND_WORKER_BATCH_SIZE"),
      () => "1",
    );
    const workerBatchSize = Number(workerBatchSizeValue);
    if (!Number.isInteger(workerBatchSize) || workerBatchSize < 1 || workerBatchSize > 50) {
      return yield* configFailure(
        "NUSEND_SEND_WORKER_BATCH_SIZE must be an integer between 1 and 50.",
      );
    }

    if (workerBatchSize * requestTimeoutMs + sendWorkerLeaseMarginMs >= workerLeaseSeconds * 1000) {
      return yield* configFailure(
        "NUSEND_SEND_WORKER_LEASE_SECONDS must exceed NUSEND_SEND_WORKER_BATCH_SIZE * NUSEND_SES_REQUEST_TIMEOUT_MS by at least 10 seconds.",
      );
    }

    return {
      fromEmail,
      marketingConfigurationSet,
      region,
      requestTimeoutMs,
      transactionalConfigurationSet,
      workerBatchSize,
      workerLeaseSeconds,
    };
  },
);
