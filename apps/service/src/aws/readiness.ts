import { Effect, Option, Result } from "effect";

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
    const checks: ReadinessCheck[] = settings.configIssues.map(configIssueCheck);
    const expectedWebhookUrl = Option.getOrNull(
      Option.map(settings.publicBaseUrl, (baseUrl) => `${baseUrl}${sesSnsWebhookPath}`),
    );

    if (Option.isSome(settings.publicBaseUrl)) {
      checks.push(ok("config.public_base_url", "Public base URL", "Public base URL is valid."));
    }
    if (Option.isSome(settings.awsRegion)) {
      checks.push(ok("config.aws_region", "AWS region", "AWS region is configured."));
    }
    if (Option.isSome(settings.fromEmail)) {
      checks.push(ok("config.from_email", "From email", "From email is configured."));
    }
    if (Option.isSome(settings.transactionalConfigurationSet)) {
      checks.push(
        ok(
          "config.configuration_set.transactional",
          "Transactional configuration set",
          "Transactional configuration set is configured.",
        ),
      );
    }
    if (Option.isSome(settings.marketingConfigurationSet)) {
      checks.push(
        ok(
          "config.configuration_set.marketing",
          "Marketing configuration set",
          "Marketing configuration set is configured.",
        ),
      );
    }
    if (settings.unsubscribeSecretConfigured) {
      checks.push(
        ok(
          "config.unsubscribe_secret",
          "Unsubscribe secret",
          "Unsubscribe signing secret is configured.",
        ),
      );
    }
    if (settings.feedbackTopicArns.length > 0) {
      checks.push(
        ok("config.feedback_topics", "SNS feedback topics", "Feedback topic ARNs are configured.", {
          count: settings.feedbackTopicArns.length,
        }),
      );
    }
    checks.push(yield* schemaCheck(), yield* latestFeedbackCheck());

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

function configIssueCheck(issue: {
  readonly id: string;
  readonly message: string;
  readonly status?: "error" | "warning";
}): ReadinessCheck {
  const action = "Fix the documented environment variable and restart Nusend.";
  return issue.status === "warning"
    ? warning(issue.id, "Configuration", issue.message, action)
    : error(issue.id, "Configuration", issue.message, action);
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

    const account = yield* Effect.result(ses.getAccount());
    if (Result.isFailure(account)) {
      checks.push(
        awsErrorCheck("aws.credentials_and_account", "AWS account access", account.failure),
      );
      return checks;
    }

    checks.push(
      ok("aws.credentials_and_account", "AWS account access", "SES GetAccount succeeded."),
    );
    checks.push(
      account.success.productionAccessEnabled
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
      account.success.sendingEnabled === false
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
      account.success.enforcementStatus === "SHUTDOWN"
        ? error(
            "ses.account.enforcement_status",
            "SES enforcement status",
            "SES account enforcement status is SHUTDOWN.",
            "Resolve SES enforcement status before sending.",
          )
        : account.success.enforcementStatus === "PROBATION"
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
      const topic = yield* Effect.result(sns.getTopicAttributes(topicArn));
      if (Result.isFailure(topic)) {
        checks.push(
          awsErrorCheck("sns.topic.exists", "SNS topic exists", topic.failure, { topicArn }),
        );
      } else {
        checks.push(
          ok("sns.topic.exists", "SNS topic exists", "SNS topic attributes are readable.", {
            signatureVersion: topic.success.signatureVersion,
            topicArn,
          }),
        );
        checks.push(
          topic.success.signatureVersion === "2"
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
                { signatureVersion: topic.success.signatureVersion, topicArn },
              ),
        );
      }

      const subscriptions = yield* Effect.result(sns.listSubscriptionsByTopic(topicArn));
      if (Result.isFailure(subscriptions)) {
        checks.push(
          awsErrorCheck(
            "sns.subscription.webhook",
            "SNS webhook subscription",
            subscriptions.failure,
            { topicArn },
          ),
        );
      } else {
        const match = expectedWebhookUrl
          ? subscriptions.success.find(
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

function configurationSetSuppressionCheck(
  kind: "marketing" | "transactional",
  name: string,
  reasons: readonly string[],
): ReadinessCheck {
  const normalized = new Set(reasons.map((reason) => reason.toUpperCase()));
  const missing = ["BOUNCE", "COMPLAINT"].filter((reason) => !normalized.has(reason));
  const prefix = `ses.config_set.${kind}`;
  return missing.length === 0
    ? ok(
        `${prefix}.suppression`,
        `${kind} SES configuration-set suppression`,
        "Configuration set suppresses bounce and complaint recipients.",
        { name, reasons },
      )
    : warning(
        `${prefix}.suppression`,
        `${kind} SES configuration-set suppression`,
        `Configuration-set suppression is missing: ${missing.join(", ")}.`,
        "Configure SuppressionOptions.SuppressedReasons=[BOUNCE,COMPLAINT] on the CloudFormation-managed SES configuration set.",
        { missing, name, reasons },
      );
}

function identityChecks(
  ses: SesAdminService,
  fromEmail: string,
): Effect.Effect<readonly ReadinessCheck[], never> {
  return Effect.gen(function* () {
    const exact = yield* Effect.result(ses.getEmailIdentity(fromEmail));
    const domain = domainFromEmail(fromEmail);
    const domainResult =
      domain && (Result.isFailure(exact) || exact.success.verifiedForSending !== true)
        ? yield* Effect.result(ses.getEmailIdentity(domain))
        : null;
    const chosen =
      Result.isSuccess(exact) && exact.success.verifiedForSending === true
        ? { identity: fromEmail, summary: exact.success }
        : domainResult !== null &&
            Result.isSuccess(domainResult) &&
            domainResult.success.verifiedForSending === true
          ? { identity: domain, summary: domainResult.success }
          : Result.isSuccess(exact)
            ? { identity: fromEmail, summary: exact.success }
            : domainResult !== null && Result.isSuccess(domainResult)
              ? { identity: domain ?? fromEmail, summary: domainResult.success }
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
        : Result.isFailure(exact)
          ? awsErrorCheck("ses.identity.from_email", "SES sender identity", exact.failure)
          : warning(
              "ses.identity.from_email",
              "SES sender identity",
              "Sender identity verification could not be confirmed.",
              "Verify the sender identity or domain in SES.",
            );

    const dkimSummary = chosen?.summary ?? (Result.isSuccess(exact) ? exact.success : null);
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
    const config = yield* Effect.result(ses.getConfigurationSet(name));
    const prefix = `ses.config_set.${kind}`;
    if (Result.isFailure(config)) {
      checks.push(
        awsErrorCheck(`${prefix}.exists`, `${kind} SES configuration set`, config.failure, {
          name,
        }),
      );
      return checks;
    }

    checks.push(
      config.success.sendingEnabled === false
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
      configurationSetSuppressionCheck(kind, name, config.success.suppressedReasons),
    );

    if (Option.isSome(settings.trackingCustomRedirectDomain) && kind === "marketing") {
      checks.push(
        config.success.trackingCustomRedirectDomain === settings.trackingCustomRedirectDomain.value
          ? ok(
              `${prefix}.tracking_domain`,
              `${kind} SES tracking domain`,
              "Configuration set tracking domain matches Nusend config.",
              { domain: config.success.trackingCustomRedirectDomain },
            )
          : warning(
              `${prefix}.tracking_domain`,
              `${kind} SES tracking domain`,
              "Configuration set tracking domain does not match Nusend config.",
              "Configure the SES custom redirect domain for engagement tracking.",
              {
                actual: config.success.trackingCustomRedirectDomain,
                expected: settings.trackingCustomRedirectDomain.value,
              },
            ),
      );
    }

    const destinations = yield* Effect.result(ses.getConfigurationSetEventDestinations(name));
    if (Result.isFailure(destinations)) {
      checks.push(
        awsErrorCheck(`${prefix}.events`, `${kind} SES event destinations`, destinations.failure, {
          name,
        }),
      );
      return checks;
    }

    const baseRequired = ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"];
    const required =
      kind === "marketing"
        ? [...baseRequired, ...settings.trackingEvents.map((event) => event.toUpperCase())]
        : baseRequired;
    const enabledToConfiguredTopic = destinations.success.filter(
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
