import { Effect, Option } from "effect";

import type { DatabaseError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { sesSnsWebhookPath, sesDocs } from "../ses/constants.ts";
import { SesOperationsConfig, type SesOperationsConfigService } from "../ses/config.ts";
import { AwsAdminError } from "./errors.ts";
import { SesAdmin, type SesAdminService } from "./ses-admin.ts";
import { SnsAdmin, type SnsAdminService } from "./sns-admin.ts";

export type ReadinessStatus = "error" | "ok" | "skipped" | "warning";

export type ReadinessCheck = {
  readonly action: string | null;
  readonly details?: Record<string, unknown>;
  readonly docs?: readonly string[];
  readonly id: string;
  readonly message: string;
  readonly status: ReadinessStatus;
  readonly title: string;
};

export type SesReadinessResult = {
  readonly checkedAt: string;
  readonly expectedWebhookUrl: string | null;
  readonly status: ReadinessStatus;
  readonly checks: readonly ReadinessCheck[];
};

export type RunSesReadinessOptions = {
  readonly includeAws?: boolean;
};

export function runSesReadinessChecks(
  options: RunSesReadinessOptions = {},
): Effect.Effect<
  SesReadinessResult,
  DatabaseError,
  SesOperationsConfigService | DatabaseService | SesAdminService | SnsAdminService
> {
  return Effect.gen(function* () {
    const settings = (yield* SesOperationsConfig).config;
    const checks: ReadinessCheck[] = [];
    const publicBaseUrl = validatePublicBaseUrl(settings.publicBaseUrl);
    const expectedWebhookUrl =
      publicBaseUrl.status === "ok"
        ? `${Option.getOrThrow(settings.publicBaseUrl)}${sesSnsWebhookPath}`
        : null;

    // Config issues are authoritative for their check ids: a local check that
    // shares an id (e.g. config.public_base_url, config.worker_budget) would
    // duplicate or contradict the diagnostic, so it is dropped.
    const configIssueIds = new Set(settings.configIssues.map((issue) => issue.id));
    const localChecks: ReadinessCheck[] = [
      publicBaseUrl,
      optionCheck({
        action: "Set AWS_REGION to the SES region used by Nusend.",
        id: "config.aws_region",
        option: settings.awsRegion,
        title: "AWS region",
      }),
      optionCheck({
        action: "Set NUSEND_SES_FROM_EMAIL to a verified SES sender.",
        id: "config.from_email",
        option: settings.fromEmail,
        title: "From email",
      }),
      optionCheck({
        action: "Set NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET.",
        id: "config.configuration_set.transactional",
        option: settings.transactionalConfigurationSet,
        title: "Transactional configuration set",
      }),
      optionCheck({
        action: "Set NUSEND_SES_MARKETING_CONFIGURATION_SET.",
        id: "config.configuration_set.marketing",
        option: settings.marketingConfigurationSet,
        title: "Marketing configuration set",
      }),
      settings.unsubscribeSecretConfigured
        ? ok(
            "config.unsubscribe_secret",
            "Unsubscribe secret",
            "Unsubscribe signing secret is configured.",
          )
        : warning(
            "config.unsubscribe_secret",
            "Unsubscribe secret",
            "Unsubscribe signing secret is missing.",
            "Set NUSEND_UNSUBSCRIBE_SECRET before marketing sends.",
          ),
      trackingConfigCheck(settings.trackingEvents, settings.trackingCustomRedirectDomain),
      settings.feedbackTopicArns.length > 0
        ? ok(
            "config.feedback_topics",
            "SNS feedback topics",
            "Feedback topic ARNs are configured.",
            {
              count: settings.feedbackTopicArns.length,
            },
          )
        : warning(
            "config.feedback_topics",
            "SNS feedback topics",
            "No SNS feedback TopicArn allowlist is configured.",
            "Set NUSEND_SES_FEEDBACK_TOPIC_ARNS to one or more SNS topic ARNs.",
          ),
      workerBudgetCheck(
        settings.workerBatchSize,
        settings.requestTimeoutMs,
        settings.workerLeaseSeconds,
      ),
      yield* schemaCheck(),
      yield* latestFeedbackCheck(),
    ];
    checks.push(
      ...settings.configIssues.map(configIssueCheck),
      ...localChecks.filter((check) => !configIssueIds.has(check.id)),
    );

    if (options.includeAws === false) {
      checks.push(
        skipped(
          "aws.credentials_and_account",
          "AWS account access",
          "AWS checks were skipped by request.",
          "Call readiness without includeAws=false to check AWS resources.",
        ),
      );
    } else if (Option.isNone(settings.awsRegion)) {
      checks.push(
        skipped(
          "aws.credentials_and_account",
          "AWS account access",
          "AWS checks need AWS_REGION first.",
          "Set AWS_REGION, then refresh readiness.",
        ),
      );
    } else {
      checks.push(...(yield* awsChecks(expectedWebhookUrl)));
    }

    const checkedAt = yield* currentIso;
    const status = aggregateStatus(checks);
    yield* Effect.logInfo("ses readiness completed", {
      checkCount: checks.length,
      errorCount: checks.filter((check) => check.status === "error").length,
      includeAws: options.includeAws !== false,
      status,
      warningCount: checks.filter((check) => check.status === "warning").length,
    });
    return { checkedAt, checks, expectedWebhookUrl, status };
  });
}

function configIssueCheck(issue: { id: string; message: string }): ReadinessCheck {
  return error(
    issue.id,
    "Configuration issue",
    issue.message,
    "Fix the invalid environment variable value and restart Nusend.",
  );
}

function optionCheck(input: {
  action: string;
  id: string;
  option: Option.Option<string>;
  title: string;
}): ReadinessCheck {
  return Option.isSome(input.option)
    ? ok(input.id, input.title, `${input.title} is configured.`)
    : warning(input.id, input.title, `${input.title} is missing.`, input.action);
}

function validatePublicBaseUrl(value: Option.Option<string>): ReadinessCheck {
  if (Option.isNone(value)) {
    return warning(
      "config.public_base_url",
      "Public base URL",
      "Public base URL is missing.",
      "Set NUSEND_PUBLIC_BASE_URL to your public HTTPS Nusend base URL.",
    );
  }

  try {
    const url = new URL(value.value);
    if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") {
      return error(
        "config.public_base_url",
        "Public base URL",
        "Public base URL must be an absolute HTTPS URL without query or fragment.",
        "Set NUSEND_PUBLIC_BASE_URL to a clean HTTPS origin/path.",
      );
    }
    return ok("config.public_base_url", "Public base URL", "Public base URL is valid.");
  } catch {
    return error(
      "config.public_base_url",
      "Public base URL",
      "Public base URL is not a valid absolute URL.",
      "Set NUSEND_PUBLIC_BASE_URL to a clean HTTPS origin/path.",
    );
  }
}

function trackingConfigCheck(
  trackingEvents: readonly string[],
  customRedirectDomain: Option.Option<string>,
): ReadinessCheck {
  if (trackingEvents.length === 0) {
    return ok("config.tracking", "SES engagement tracking", "Open/click tracking is disabled.");
  }

  if (Option.isNone(customRedirectDomain)) {
    return warning(
      "config.tracking",
      "SES engagement tracking",
      "Open/click tracking is enabled without a custom redirect domain.",
      "Configure NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN if you want branded tracking links.",
    );
  }

  return ok(
    "config.tracking",
    "SES engagement tracking",
    "Tracking events and custom redirect domain are configured.",
  );
}

function workerBudgetCheck(
  batchSize: number,
  requestTimeoutMs: number,
  leaseSeconds: number,
): ReadinessCheck {
  const valid = batchSize * requestTimeoutMs + 10_000 < leaseSeconds * 1000;
  return valid
    ? ok(
        "config.worker_budget",
        "Worker lease budget",
        "Worker timeout and lease settings are compatible.",
      )
    : error(
        "config.worker_budget",
        "Worker lease budget",
        "Worker lease must exceed batch size times SES request timeout by at least 10 seconds.",
        "Increase NUSEND_SEND_WORKER_LEASE_SECONDS or lower batch size/request timeout.",
      );
}

function schemaCheck(): Effect.Effect<ReadinessCheck, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db.all<{ name: string }>(
      "ses:readiness:schema",
      `SELECT name FROM sqlite_schema
       WHERE type = 'table'
         AND name IN ('ses_notifications', 'ses_events', 'ses_simulator_runs', 'worker_runs')
       ORDER BY name;`,
    );
    const names = rows.map((row) => row.name);
    return names.length === 4
      ? ok(
          "db.ses_operations_schema",
          "SES operations schema",
          "SES operations tables are migrated.",
        )
      : error(
          "db.ses_operations_schema",
          "SES operations schema",
          "SES operations tables are missing.",
          "Run pnpm --filter @nusend/service db:migrate.",
          { foundTables: names },
        );
  });
}

function latestFeedbackCheck(): Effect.Effect<ReadinessCheck, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{ receivedAt: string }>(
      "ses:readiness:latest-feedback",
      "SELECT received_at AS receivedAt FROM ses_notifications ORDER BY received_at DESC LIMIT 1;",
    );
    return row
      ? ok(
          "operations.latest_feedback",
          "Latest SES event",
          "Nusend has received SES notifications.",
          {
            receivedAt: row.receivedAt,
          },
        )
      : warning(
          "operations.latest_feedback",
          "Latest SES event",
          "No SES notification has been received yet.",
          "Run SES simulator end-to-end scenarios after AWS setup is complete.",
        );
  });
}

function awsChecks(
  expectedWebhookUrl: string | null,
): Effect.Effect<
  readonly ReadinessCheck[],
  never,
  SesOperationsConfigService | SesAdminService | SnsAdminService
> {
  return Effect.gen(function* () {
    const settings = (yield* SesOperationsConfig).config;
    const ses = yield* SesAdmin;
    const sns = yield* SnsAdmin;
    const checks: ReadinessCheck[] = [];

    const account = yield* capture(ses.getAccount());
    if (account.tag === "Left") {
      checks.push(awsErrorCheck("aws.credentials_and_account", "AWS account access", account.left));
      return checks;
    }

    checks.push(
      ok("aws.credentials_and_account", "AWS account access", "SES GetAccount succeeded."),
    );
    checks.push(
      account.right.productionAccessEnabled
        ? ok(
            "ses.account.production_access",
            "SES production access",
            "SES account has production access.",
          )
        : warning(
            "ses.account.production_access",
            "SES production access",
            "SES account appears to be in sandbox or did not report production access.",
            "Request SES production access before real non-simulator sending.",
          ),
      account.right.sendingEnabled === false
        ? error(
            "ses.account.sending_enabled",
            "SES sending enabled",
            "SES sending is disabled for this account/region.",
            "Resolve SES account status in AWS Console.",
          )
        : ok(
            "ses.account.sending_enabled",
            "SES sending enabled",
            "SES sending is enabled or not reported disabled.",
          ),
      account.right.enforcementStatus === "SHUTDOWN"
        ? error(
            "ses.account.enforcement_status",
            "SES enforcement status",
            "SES account enforcement status is SHUTDOWN.",
            "Resolve SES enforcement status before sending.",
          )
        : account.right.enforcementStatus === "PROBATION"
          ? warning(
              "ses.account.enforcement_status",
              "SES enforcement status",
              "SES account is on probation.",
              "Review SES reputation and sending practices.",
            )
          : ok(
              "ses.account.enforcement_status",
              "SES enforcement status",
              "SES enforcement status is healthy or not reported.",
            ),
      accountSuppressionCheck(account.right.suppressionReasons),
    );

    if (Option.isSome(settings.fromEmail)) {
      checks.push(...(yield* identityChecks(ses, settings.fromEmail.value)));
    }

    for (const [kind, option] of [
      ["transactional", settings.transactionalConfigurationSet],
      ["marketing", settings.marketingConfigurationSet],
    ] as const) {
      if (Option.isNone(option)) continue;
      checks.push(
        ...(yield* configurationSetChecks(ses, kind, option.value, settings.feedbackTopicArns)),
      );
    }

    for (const topicArn of settings.feedbackTopicArns) {
      const topic = yield* capture(sns.getTopicAttributes(topicArn));
      if (topic.tag === "Left") {
        checks.push(
          awsErrorCheck("sns.topic.exists", "SNS topic exists", topic.left, { topicArn }),
        );
      } else {
        checks.push(
          ok("sns.topic.exists", "SNS topic exists", "SNS topic attributes are readable.", {
            signatureVersion: topic.right.signatureVersion,
            topicArn,
          }),
        );
        checks.push(
          topic.right.signatureVersion === "2"
            ? ok(
                "sns.topic.signature_version",
                "SNS signature version",
                "SNS topic uses signature version 2.",
                { topicArn },
              )
            : warning(
                "sns.topic.signature_version",
                "SNS signature version",
                "SNS topic does not report SignatureVersion 2.",
                "Set the SNS topic SignatureVersion attribute to 2.",
                { signatureVersion: topic.right.signatureVersion, topicArn },
              ),
        );
      }

      const subscriptions = yield* capture(sns.listSubscriptionsByTopic(topicArn));
      if (subscriptions.tag === "Left") {
        checks.push(
          awsErrorCheck(
            "sns.subscription.webhook",
            "SNS webhook subscription",
            subscriptions.left,
            { topicArn },
          ),
        );
      } else {
        const match = expectedWebhookUrl
          ? subscriptions.right.find(
              (subscription) =>
                subscription.protocol === "https" &&
                subscription.endpoint === expectedWebhookUrl &&
                subscription.subscriptionArn !== "PendingConfirmation",
            )
          : undefined;
        checks.push(
          match
            ? ok(
                "sns.subscription.webhook",
                "SNS webhook subscription",
                "Confirmed HTTPS webhook subscription found.",
                {
                  endpoint: match.endpoint,
                  topicArn,
                },
              )
            : warning(
                "sns.subscription.webhook",
                "SNS webhook subscription",
                "No confirmed HTTPS subscription matches the Nusend webhook URL.",
                "Subscribe SNS to the public Nusend webhook endpoint and confirm the subscription.",
                { expectedWebhookUrl, topicArn },
              ),
        );
      }
    }

    return checks;
  });
}

function accountSuppressionCheck(reasons: readonly string[]): ReadinessCheck {
  const normalized = new Set(reasons.map((reason) => reason.toUpperCase()));
  const missing = ["BOUNCE", "COMPLAINT"].filter((reason) => !normalized.has(reason));
  return missing.length === 0
    ? ok(
        "ses.account.suppression_recommendation",
        "SES account-level suppression",
        "SES account-level suppression includes bounce and complaint defense in depth.",
        { reasons },
      )
    : warning(
        "ses.account.suppression_recommendation",
        "SES account-level suppression",
        `SES account-level suppression is missing: ${missing.join(", ")}.`,
        "Enable SES account-level suppression for BOUNCE and COMPLAINT as defense in depth.",
        { missing, reasons },
      );
}

function identityChecks(
  ses: SesAdminService,
  fromEmail: string,
): Effect.Effect<readonly ReadinessCheck[], never> {
  return Effect.gen(function* () {
    const exact = yield* capture(ses.getEmailIdentity(fromEmail));
    const domain = domainFromEmail(fromEmail);
    const domainResult =
      domain && (exact.tag === "Left" || exact.right.verifiedForSending !== true)
        ? yield* capture(ses.getEmailIdentity(domain))
        : null;
    const chosen =
      exact.tag === "Right" && exact.right.verifiedForSending === true
        ? { identity: fromEmail, summary: exact.right }
        : domainResult?.tag === "Right" && domainResult.right.verifiedForSending === true
          ? { identity: domain, summary: domainResult.right }
          : exact.tag === "Right"
            ? { identity: fromEmail, summary: exact.right }
            : domainResult?.tag === "Right"
              ? { identity: domain ?? fromEmail, summary: domainResult.right }
              : null;

    const identity =
      chosen !== null
        ? chosen.summary.verifiedForSending
          ? ok(
              "ses.identity.from_email",
              "SES sender identity",
              "SES sender identity is verified for sending.",
              { identity: chosen.identity },
            )
          : warning(
              "ses.identity.from_email",
              "SES sender identity",
              "Neither sender email nor domain identity is verified for sending.",
              "Verify the sender identity or domain in SES.",
              { identity: chosen.identity },
            )
        : exact.tag === "Left"
          ? awsErrorCheck("ses.identity.from_email", "SES sender identity", exact.left)
          : warning(
              "ses.identity.from_email",
              "SES sender identity",
              "Sender identity verification could not be confirmed.",
              "Verify the sender identity or domain in SES.",
            );

    const dkimSummary = chosen?.summary ?? (exact.tag === "Right" ? exact.right : null);
    const dkim =
      dkimSummary?.dkimStatus === "SUCCESS"
        ? ok("ses.identity.dkim", "SES DKIM", "DKIM is successfully configured.", {
            dkimStatus: dkimSummary.dkimStatus,
            identity: chosen?.identity ?? fromEmail,
          })
        : warning(
            "ses.identity.dkim",
            "SES DKIM",
            "DKIM is not confirmed as successful for the selected SES identity.",
            "Configure DKIM for the sending identity and wait for SUCCESS status.",
            {
              dkimStatus: dkimSummary?.dkimStatus ?? null,
              identity: chosen?.identity ?? fromEmail,
            },
          );

    return [identity, dkim];
  });
}

function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).toLowerCase() : null;
}

function configurationSetChecks(
  ses: SesAdminService,
  kind: "marketing" | "transactional",
  name: string,
  topicArns: readonly string[],
): Effect.Effect<readonly ReadinessCheck[], never, SesOperationsConfigService> {
  return Effect.gen(function* () {
    const checks: ReadinessCheck[] = [];
    const settings = (yield* SesOperationsConfig).config;
    const config = yield* capture(ses.getConfigurationSet(name));
    const prefix = `ses.config_set.${kind}`;
    if (config.tag === "Left") {
      checks.push(
        awsErrorCheck(`${prefix}.exists`, `${kind} SES configuration set`, config.left, { name }),
      );
      return checks;
    }

    checks.push(
      config.right.sendingEnabled === false
        ? error(
            `${prefix}.exists`,
            `${kind} SES configuration set`,
            "Configuration set exists but sending is disabled.",
            "Enable sending for the SES configuration set.",
            { name },
          )
        : ok(`${prefix}.exists`, `${kind} SES configuration set`, "Configuration set exists.", {
            name,
          }),
    );

    if (Option.isSome(settings.trackingCustomRedirectDomain) && kind === "marketing") {
      checks.push(
        config.right.trackingCustomRedirectDomain === settings.trackingCustomRedirectDomain.value
          ? ok(
              `${prefix}.tracking_domain`,
              `${kind} SES tracking domain`,
              "Configuration set tracking domain matches Nusend config.",
              { domain: config.right.trackingCustomRedirectDomain },
            )
          : warning(
              `${prefix}.tracking_domain`,
              `${kind} SES tracking domain`,
              "Configuration set tracking domain does not match Nusend config.",
              "Configure the SES custom redirect domain for engagement tracking.",
              {
                actual: config.right.trackingCustomRedirectDomain,
                expected: settings.trackingCustomRedirectDomain.value,
              },
            ),
      );
    }

    const destinations = yield* capture(ses.getConfigurationSetEventDestinations(name));
    if (destinations.tag === "Left") {
      checks.push(
        awsErrorCheck(`${prefix}.events`, `${kind} SES event destinations`, destinations.left, {
          name,
        }),
      );
      return checks;
    }

    const required =
      kind === "marketing"
        ? ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY", "OPEN", "CLICK"]
        : ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"];
    const enabledToConfiguredTopic = destinations.right.filter(
      (destination) =>
        destination.enabled &&
        destination.matchingTopicArn !== null &&
        topicArns.includes(destination.matchingTopicArn),
    );
    const eventTypes = new Set(
      enabledToConfiguredTopic.flatMap((destination) => destination.eventTypes),
    );
    const missing = required.filter((eventType) => !eventTypes.has(eventType));
    checks.push(
      missing.length === 0
        ? ok(
            `${prefix}.events`,
            `${kind} SES event destinations`,
            "Required SES events publish to a configured SNS topic.",
            {
              eventTypes: [...eventTypes].sort(),
            },
          )
        : warning(
            `${prefix}.events`,
            `${kind} SES event destinations`,
            `Missing configured SES event publishing for: ${missing.join(", ")}.`,
            "Add SES event destinations publishing required events to the configured SNS topic.",
            { missing, name },
          ),
    );
    return checks;
  });
}

function capture<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  { readonly tag: "Left"; readonly left: E } | { readonly tag: "Right"; readonly right: A },
  never,
  R
> {
  return effect.pipe(
    Effect.match({
      onFailure: (left) => ({ tag: "Left" as const, left }),
      onSuccess: (right) => ({ tag: "Right" as const, right }),
    }),
  );
}

function awsErrorCheck(
  id: string,
  title: string,
  failure: AwsAdminError,
  details: Record<string, unknown> = {},
): ReadinessCheck {
  const messages = {
    access_denied: "AWS credentials lack permission for this readiness check.",
    missing_credentials: "AWS credentials are unavailable to the app.",
    not_found: "The AWS resource was not found.",
    throttled: "AWS throttled this readiness check.",
    timeout: "AWS readiness check timed out.",
    unknown: "AWS readiness check failed.",
  } satisfies Record<AwsAdminError["kind"], string>;
  return {
    action: "Grant the documented IAM permissions and verify the configured AWS resources.",
    details: { ...details, kind: failure.kind, operation: failure.operation },
    docs: [sesDocs.readiness],
    id,
    message: messages[failure.kind],
    status: failure.kind === "not_found" ? "warning" : "error",
    title,
  };
}

function aggregateStatus(checks: readonly ReadinessCheck[]): ReadinessStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning" || check.status === "skipped"))
    return "warning";
  return "ok";
}

function ok(
  id: string,
  title: string,
  message: string,
  details?: Record<string, unknown>,
): ReadinessCheck {
  return { action: null, details, docs: [sesDocs.readiness], id, message, status: "ok", title };
}

function warning(
  id: string,
  title: string,
  message: string,
  action: string,
  details?: Record<string, unknown>,
): ReadinessCheck {
  return { action, details, docs: [sesDocs.readiness], id, message, status: "warning", title };
}

function error(
  id: string,
  title: string,
  message: string,
  action: string,
  details?: Record<string, unknown>,
): ReadinessCheck {
  return { action, details, docs: [sesDocs.readiness], id, message, status: "error", title };
}

function skipped(id: string, title: string, message: string, action: string): ReadinessCheck {
  return { action, docs: [sesDocs.readiness], id, message, status: "skipped", title };
}
