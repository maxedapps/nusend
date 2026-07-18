// Effect Config definitions for the service. Values are read through the ambient
// ConfigProvider: production boundaries provide ConfigProvider.fromEnv(), tests
// provide ConfigProvider.fromUnknown(fixture).
//
// Empty/whitespace-only values count as missing. Auth configuration is
// all-or-nothing with a hard failure on partial configuration.
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, ConfigProvider, Effect, Option, Redacted } from "effect";

import type {
  SesOperationsConfig as ParsedSesOperationsConfig,
  SesOperationsConfigIssue,
} from "./ses/config.ts";
import type { UnsubscribeConfig as ParsedUnsubscribeConfig } from "./unsubscribe/config.ts";

export type AuthConfig = {
  baseUrl: string;
  googleClientId: string;
  googleClientSecret: Redacted.Redacted<string>;
  secret: Redacted.Redacted<string>;
  trustedOrigins: string[];
};

export type ServiceConfig = {
  apiKeyHashSecret: Option.Option<Redacted.Redacted<string>>;
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
  workerPollMs: number;
};

export type {
  ParsedSesOperationsConfig as SesOperationsConfig,
  ParsedUnsubscribeConfig as UnsubscribeConfig,
};

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const defaultDatabasePath = ".data/nusend.sqlite";
const sendWorkerLeaseMarginMs = 10_000;

type NumericConfigSpec = {
  readonly defaultValue: number;
  readonly envName: string;
  readonly issueId: string;
  readonly max: number | null;
  readonly message: string;
  readonly min: number;
};

const numericConfigSpecs = {
  requestTimeoutMs: {
    defaultValue: 30_000,
    envName: "NUSEND_SES_REQUEST_TIMEOUT_MS",
    issueId: "config.request_timeout_ms",
    max: null,
    message: "NUSEND_SES_REQUEST_TIMEOUT_MS must be an integer >= 1.",
    min: 1,
  },
  workerBatchSize: {
    defaultValue: 1,
    envName: "NUSEND_SEND_WORKER_BATCH_SIZE",
    issueId: "config.worker_batch_size",
    max: 50,
    message: "NUSEND_SEND_WORKER_BATCH_SIZE must be an integer between 1 and 50.",
    min: 1,
  },
  workerLeaseSeconds: {
    defaultValue: 300,
    envName: "NUSEND_SEND_WORKER_LEASE_SECONDS",
    issueId: "config.worker_lease_seconds",
    max: null,
    message: "NUSEND_SEND_WORKER_LEASE_SECONDS must be an integer >= 1.",
    min: 1,
  },
  workerPollMs: {
    defaultValue: 5_000,
    envName: "NUSEND_SEND_WORKER_POLL_MS",
    issueId: "config.worker_poll_ms",
    max: null,
    message: "NUSEND_SEND_WORKER_POLL_MS must be an integer >= 1.",
    min: 1,
  },
} as const satisfies Record<string, NumericConfigSpec>;

// Single source of truth for the lease-budget rule, consumed by both the
// readiness-diagnostics config and the hard-failing sending config so they
// cannot drift.
const sendWorkerLeaseBudgetMessage =
  "NUSEND_SEND_WORKER_LEASE_SECONDS must exceed NUSEND_SEND_WORKER_BATCH_SIZE * NUSEND_SES_REQUEST_TIMEOUT_MS by at least 10 seconds.";

function sendWorkerLeaseBudgetInsufficient(input: {
  readonly batchSize: number;
  readonly requestTimeoutMs: number;
  readonly leaseSeconds: number;
}): boolean {
  return (
    input.batchSize * input.requestTimeoutMs + sendWorkerLeaseMarginMs >= input.leaseSeconds * 1000
  );
}

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
    // trimmedOption so "production\n"/"production " still enables the production
    // HTTPS enforcement below (a whitespace typo must not silently disable it).
    const nodeEnv = yield* trimmedOption("NODE_ENV");

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

    const portValue = Option.getOrElse(yield* trimmedOption("NUSEND_PORT"), () => "3000");
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return yield* configFailure("NUSEND_PORT must be an integer between 1 and 65535.");
    }

    const databasePath = resolveDatabasePath(
      Option.getOrElse(yield* trimmedOption("NUSEND_DB_PATH"), () => defaultDatabasePath),
    );

    const auth = yield* authConfig;
    const apiKeyHashSecret = yield* trimmedOption("NUSEND_API_KEY_HASH_SECRET");
    if (Option.isSome(auth) && Option.isNone(apiKeyHashSecret)) {
      return yield* configFailure(
        "NUSEND_API_KEY_HASH_SECRET is required when auth is configured.",
      );
    }
    if (Option.isSome(apiKeyHashSecret) && apiKeyHashSecret.value.length < 32) {
      return yield* configFailure("NUSEND_API_KEY_HASH_SECRET must be at least 32 characters.");
    }

    return {
      apiKeyHashSecret: Option.map(apiKeyHashSecret, Redacted.make),
      auth,
      databasePath,
      host,
      port,
    };
  },
);

type SharedWorkerNumericConfig = {
  readonly issues: SesOperationsConfigIssue[];
  readonly requestTimeoutMs: number;
  readonly workerBatchSize: number;
  readonly workerLeaseSeconds: number;
  readonly workerPollMs: number;
};

export type DeploymentConfig = {
  readonly service: ServiceConfig;
  readonly sesOperations: ParsedSesOperationsConfig;
  readonly unsubscribe: Option.Option<ParsedUnsubscribeConfig>;
};

const sharedWorkerNumericConfig: Effect.Effect<SharedWorkerNumericConfig, Config.ConfigError> =
  Effect.gen(function* () {
    const issues: SesOperationsConfigIssue[] = [];
    const requestTimeoutMs = parseSoftInteger(
      numericConfigSpecs.requestTimeoutMs,
      yield* trimmedOption(numericConfigSpecs.requestTimeoutMs.envName),
      issues,
    );
    const workerBatchSize = parseSoftInteger(
      numericConfigSpecs.workerBatchSize,
      yield* trimmedOption(numericConfigSpecs.workerBatchSize.envName),
      issues,
    );
    const workerLeaseSeconds = parseSoftInteger(
      numericConfigSpecs.workerLeaseSeconds,
      yield* trimmedOption(numericConfigSpecs.workerLeaseSeconds.envName),
      issues,
    );
    const workerPollMs = parseSoftInteger(
      numericConfigSpecs.workerPollMs,
      yield* trimmedOption(numericConfigSpecs.workerPollMs.envName),
      issues,
    );

    if (
      sendWorkerLeaseBudgetInsufficient({
        batchSize: workerBatchSize,
        leaseSeconds: workerLeaseSeconds,
        requestTimeoutMs,
      })
    ) {
      issues.push({
        blocksWorker: true,
        id: "config.worker_budget",
        message: sendWorkerLeaseBudgetMessage,
        status: "error",
      });
    }

    return {
      issues,
      requestTimeoutMs,
      workerBatchSize,
      workerLeaseSeconds,
      workerPollMs,
    };
  });

/** One deployment parse consumed once by the API, send worker, and simulator entrypoints. */
export const deploymentConfig: Effect.Effect<DeploymentConfig, Config.ConfigError> = Effect.gen(
  function* () {
    const service = yield* serviceConfig;
    const shared = yield* sharedWorkerNumericConfig;
    const issues = [...shared.issues];

    const awsRegion = yield* trimmedOption("AWS_REGION");
    const fromEmail = yield* trimmedOption("NUSEND_SES_FROM_EMAIL");
    const transactionalConfigurationSet = yield* trimmedOption(
      "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET",
    );
    const marketingConfigurationSet = yield* trimmedOption(
      "NUSEND_SES_MARKETING_CONFIGURATION_SET",
    );
    const publicBaseUrlInput = yield* trimmedOption("NUSEND_PUBLIC_BASE_URL");
    const unsubscribeSecret = yield* trimmedOption("NUSEND_UNSUBSCRIBE_SECRET");
    const previousUnsubscribeSecret = yield* trimmedOption("NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET");
    const feedbackTopicArns = uniqueCsv(
      Option.getOrElse(yield* trimmedOption("NUSEND_SES_FEEDBACK_TOPIC_ARNS"), () => ""),
    );
    const trackingEvents = parseTrackingEvents(
      Option.getOrElse(yield* trimmedOption("NUSEND_SES_TRACKING_EVENTS"), () => ""),
      issues,
    );
    const trackingCustomRedirectDomain = yield* trimmedOption(
      "NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN",
    );

    addMissingIssue(issues, awsRegion, {
      blocksWorker: true,
      id: "config.aws_region",
      message: "AWS_REGION is required for the send worker.",
    });
    addMissingIssue(issues, fromEmail, {
      blocksWorker: true,
      id: "config.from_email",
      message: "NUSEND_SES_FROM_EMAIL is required for the send worker.",
    });
    addMissingIssue(issues, transactionalConfigurationSet, {
      blocksWorker: true,
      id: "config.configuration_set.transactional",
      message: "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET is required for the send worker.",
      status: "error",
    });
    addMissingIssue(issues, marketingConfigurationSet, {
      id: "config.configuration_set.marketing",
      message: "Marketing configuration set is missing.",
    });

    const publicBaseUrl = normalizePublicBaseUrl(publicBaseUrlInput, issues);
    if (Option.isNone(publicBaseUrlInput)) {
      issues.push({
        id: "config.public_base_url",
        message: "Public base URL is missing.",
        status: "warning",
      });
    }

    const unsubscribe = parseUnsubscribeConfig(
      publicBaseUrlInput,
      publicBaseUrl,
      unsubscribeSecret,
      previousUnsubscribeSecret,
      issues,
    );
    if (
      Option.isNone(unsubscribe) &&
      Option.isNone(unsubscribeSecret) &&
      Option.isNone(previousUnsubscribeSecret)
    ) {
      issues.push({
        id: "config.unsubscribe_secret",
        message: "Unsubscribe signing secret is missing.",
        status: "warning",
      });
    }

    if (feedbackTopicArns.length === 0) {
      issues.push({
        id: "config.feedback_topics",
        message: "No SNS feedback TopicArn allowlist is configured.",
        status: "warning",
      });
    }
    if (trackingEvents.length > 0 && Option.isNone(trackingCustomRedirectDomain)) {
      issues.push({
        id: "config.tracking",
        message: "Open/click tracking is enabled without a custom redirect domain.",
        status: "warning",
      });
    }

    return {
      service,
      sesOperations: {
        awsRegion,
        configIssues: issues,
        feedbackTopicArns,
        fromEmail,
        marketingConfigurationSet,
        publicBaseUrl,
        requestTimeoutMs: shared.requestTimeoutMs,
        trackingCustomRedirectDomain,
        trackingEvents,
        transactionalConfigurationSet,
        unsubscribeSecretConfigured: Option.isSome(unsubscribe),
        workerBatchSize: shared.workerBatchSize,
        workerLeaseSeconds: shared.workerLeaseSeconds,
        workerPollMs: shared.workerPollMs,
      },
      unsubscribe,
    };
  },
);

export function sendingConfigFromDeployment(
  deployment: DeploymentConfig,
): Effect.Effect<SendingConfig, Config.ConfigError> {
  const blockingIssue = deployment.sesOperations.configIssues.find(
    (issue) => issue.blocksWorker === true,
  );
  if (blockingIssue) return configFailure(blockingIssue.message);

  return Effect.succeed({
    fromEmail: Option.getOrThrow(deployment.sesOperations.fromEmail),
    marketingConfigurationSet: Option.getOrNull(deployment.sesOperations.marketingConfigurationSet),
    region: Option.getOrThrow(deployment.sesOperations.awsRegion),
    requestTimeoutMs: deployment.sesOperations.requestTimeoutMs,
    transactionalConfigurationSet: Option.getOrThrow(
      deployment.sesOperations.transactionalConfigurationSet,
    ),
    workerBatchSize: deployment.sesOperations.workerBatchSize,
    workerLeaseSeconds: deployment.sesOperations.workerLeaseSeconds,
    workerPollMs: deployment.sesOperations.workerPollMs,
  });
}

function addMissingIssue(
  issues: SesOperationsConfigIssue[],
  value: Option.Option<string>,
  issue: Omit<SesOperationsConfigIssue, "status"> & {
    readonly status?: SesOperationsConfigIssue["status"];
  },
): void {
  if (Option.isSome(value)) return;
  issues.push({ ...issue, status: issue.status ?? "warning" });
}

function uniqueCsv(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function parseTrackingEvents(
  value: string,
  issues: SesOperationsConfigIssue[],
): ("click" | "open")[] {
  const configured = uniqueCsv(value);
  const valid = configured.filter(
    (item): item is "click" | "open" => item === "click" || item === "open",
  );
  const unsupported = configured.filter((item) => item !== "click" && item !== "open");
  if (unsupported.length > 0) {
    issues.push({
      id: "config.tracking_events",
      message: `NUSEND_SES_TRACKING_EVENTS contains unsupported values: ${unsupported.join(", ")}. Use only open and click.`,
      status: "error",
    });
  }
  return valid;
}

function parseSoftInteger(
  spec: NumericConfigSpec,
  value: Option.Option<string>,
  issues: SesOperationsConfigIssue[],
): number {
  if (Option.isNone(value)) return spec.defaultValue;
  const parsed = Number(value.value);
  if (validNumericConfigValue(spec, parsed)) return parsed;
  issues.push({
    blocksWorker: true,
    id: spec.issueId,
    message: spec.message,
    status: "error",
  });
  return spec.defaultValue;
}

function validNumericConfigValue(spec: NumericConfigSpec, value: number): boolean {
  return Number.isInteger(value) && value >= spec.min && (spec.max === null || value <= spec.max);
}

type PublicBaseUrlValidation =
  | { readonly kind: "None" }
  | { readonly kind: "Valid"; readonly normalized: string }
  | { readonly kind: "Invalid"; readonly message: string };

function validatePublicBaseUrl(value: Option.Option<string>): PublicBaseUrlValidation {
  if (Option.isNone(value)) return { kind: "None" };
  const raw = value.value;
  const parsed = parseAbsoluteUrl(raw);
  if (!parsed || parsed.protocol !== "https:") {
    return { kind: "Invalid", message: "NUSEND_PUBLIC_BASE_URL must be an absolute HTTPS URL." };
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return {
      kind: "Invalid",
      message: "NUSEND_PUBLIC_BASE_URL must not include a query string or fragment.",
    };
  }
  if (/[&'"<>]/.test(raw)) {
    return {
      kind: "Invalid",
      message: "NUSEND_PUBLIC_BASE_URL must not include HTML-escapable characters.",
    };
  }
  return { kind: "Valid", normalized: parsed.toString().replace(/\/$/, "") };
}

function normalizePublicBaseUrl(
  value: Option.Option<string>,
  issues: SesOperationsConfigIssue[],
): Option.Option<string> {
  const result = validatePublicBaseUrl(value);
  if (result.kind === "Valid") return Option.some(result.normalized);
  if (result.kind === "Invalid") {
    issues.push({
      blocksWorker: true,
      id: "config.public_base_url",
      message: result.message,
      status: "error",
    });
  }
  return Option.none();
}

function parseUnsubscribeConfig(
  publicBaseUrlInput: Option.Option<string>,
  publicBaseUrl: Option.Option<string>,
  currentSecret: Option.Option<string>,
  previousSecret: Option.Option<string>,
  issues: SesOperationsConfigIssue[],
): Option.Option<ParsedUnsubscribeConfig> {
  if (Option.isNone(currentSecret) && Option.isNone(previousSecret)) {
    return Option.none();
  }

  const missing: string[] = [];
  if (Option.isNone(publicBaseUrlInput)) missing.push("NUSEND_PUBLIC_BASE_URL");
  if (Option.isNone(currentSecret)) missing.push("NUSEND_UNSUBSCRIBE_SECRET");
  if (missing.length > 0) {
    issues.push({
      blocksWorker: true,
      id: "config.unsubscribe",
      message: `Unsubscribe is partially configured. Missing: ${missing.join(", ")}.`,
      status: "error",
    });
    return Option.none();
  }
  if (Option.isNone(publicBaseUrl)) return Option.none();

  const current = Option.getOrThrow(currentSecret);
  if (current.length < 32) {
    issues.push(unsubscribeIssue("NUSEND_UNSUBSCRIBE_SECRET must be at least 32 characters."));
    return Option.none();
  }

  let previous: Redacted.Redacted<string> | null = null;
  if (Option.isSome(previousSecret)) {
    if (previousSecret.value.length < 32) {
      issues.push(
        unsubscribeIssue("NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET must be at least 32 characters."),
      );
      return Option.none();
    }
    if (previousSecret.value === current) {
      issues.push(
        unsubscribeIssue(
          "NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET must differ from NUSEND_UNSUBSCRIBE_SECRET.",
        ),
      );
      return Option.none();
    }
    previous = Redacted.make(previousSecret.value);
  }

  return Option.some({
    currentSecret: Redacted.make(current),
    previousSecret: previous,
    publicBaseUrl: publicBaseUrl.value,
  });
}

function unsubscribeIssue(message: string): SesOperationsConfigIssue {
  return {
    blocksWorker: true,
    id: "config.unsubscribe",
    message,
    status: "error",
  };
}
