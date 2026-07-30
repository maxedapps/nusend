/**
 * Shared SNS subscription absence / final-state policy.
 * Consumed by AWS finalize apply (T5) and ready for validation (T6).
 * No generic AWS provider abstractions.
 */
import { Effect } from "effect";

import { SetupCommandError, SetupStoreError } from "../errors.ts";
import type { ProcessResult } from "../process-runner.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import { unwrapEnvValue } from "../state/env.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import type { TerminalService } from "../terminal.ts";
import {
  WEBHOOK_PATH,
  SUBSCRIPTION_POLL_ATTEMPTS,
  SUBSCRIPTION_POLL_INTERVAL,
} from "./constants.ts";
import { AwsCommandError } from "./errors.ts";
import {
  decodeAwsJson,
  SnsSubscriptionAttributesResultSchema,
  SnsSubscriptionsResultSchema,
} from "./schemas.ts";

export type SnsSubscription = {
  readonly subscriptionArn: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly owner: string;
};

export type SubscriptionAttributes = {
  readonly endpoint: string;
  readonly protocol: string;
  readonly pending: boolean;
  readonly rawMessageDelivery: string;
  readonly redriveArn: string;
};

export type PreFinalizeAbsenceEvidence = {
  readonly verified: true;
  readonly topicArn: string;
  readonly expectedEndpoint: string;
  readonly httpsCount: 0;
};

export type FinalizedSubscriptionEvidence = {
  readonly verified: true;
  readonly topicArn: string;
  readonly subscriptionArn: string;
  readonly endpoint: string;
  readonly rawMessageDelivery: false;
  readonly dlqArn: string;
};

/** Run a single AWS CLI argv (already profile/region bound) and return ProcessResult. */
export type AwsCommandRunner = (
  command: readonly string[],
  options?: { readonly allowNonZero?: boolean },
) => Effect.Effect<ProcessResult, AwsCommandError>;

export function stackOutputs(state: SetupState): Record<string, string> {
  const outputs = state.aws?.stack?.outputs;
  if (outputs == null || typeof outputs !== "object" || Array.isArray(outputs)) {
    throw new Error("Stored stack outputs are missing. Apply the core stack first.");
  }
  return outputs as Record<string, string>;
}

export function expectedWebhookEndpoint(state: SetupState): string {
  return `https://${state.config.domain}${WEBHOOK_PATH}`;
}

export function parseSubscriptions(payload: unknown): SnsSubscription[] {
  const raw = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (!Array.isArray(raw.Subscriptions)) {
    throw new Error("SNS subscription response is malformed.");
  }
  return raw.Subscriptions.map((entry) => {
    const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      subscriptionArn: String(item.SubscriptionArn ?? ""),
      protocol: String(item.Protocol ?? "").toLowerCase(),
      endpoint: String(item.Endpoint ?? ""),
      owner: String(item.Owner ?? ""),
    };
  });
}

export function parseSubscriptionAttributes(payload: unknown): SubscriptionAttributes {
  const attrs =
    payload && typeof payload === "object"
      ? (payload as { Attributes?: unknown }).Attributes
      : null;
  if (attrs == null || typeof attrs !== "object" || Array.isArray(attrs)) {
    throw new Error("SNS subscription attributes response is malformed.");
  }
  const record = attrs as Record<string, unknown>;
  let redrive: { deadLetterTargetArn?: unknown } | null = null;
  if (typeof record.RedrivePolicy === "string" && record.RedrivePolicy.trim()) {
    try {
      redrive = JSON.parse(record.RedrivePolicy) as { deadLetterTargetArn?: unknown };
    } catch (error) {
      throw new Error("SNS subscription RedrivePolicy is malformed JSON.", { cause: error });
    }
  }
  return {
    endpoint: String(record.Endpoint ?? ""),
    protocol: String(record.Protocol ?? "").toLowerCase(),
    pending: String(record.PendingConfirmation ?? "").toLowerCase() === "true",
    rawMessageDelivery: String(record.RawMessageDelivery ?? "").toLowerCase(),
    redriveArn: String(redrive?.deadLetterTargetArn ?? ""),
  };
}

/** Read every page so a pending/duplicate subscription cannot hide behind NextToken. */
export function listTopicSubscriptions(
  run: AwsCommandRunner,
  topicArn: string,
): Effect.Effect<readonly SnsSubscription[], AwsCommandError | SetupCommandError> {
  return Effect.gen(function* () {
    const subscriptions: SnsSubscription[] = [];
    let nextToken = "";
    do {
      const command = [
        "sns",
        "list-subscriptions-by-topic",
        "--topic-arn",
        topicArn,
        "--output",
        "json",
      ];
      if (nextToken) command.push("--next-token", nextToken);
      const result = yield* run(command);
      const payload = yield* decodeAwsJson(
        SnsSubscriptionsResultSchema,
        result.stdout,
        "sns list-subscriptions-by-topic",
      );
      try {
        subscriptions.push(...parseSubscriptions(payload));
      } catch (error) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      nextToken = typeof payload.NextToken === "string" ? payload.NextToken : "";
    } while (nextToken);
    return subscriptions;
  });
}

/** Guard used before the finalize change set is created or executed (AVAILABLE path). */
export function assertPreFinalizeSubscriptionAbsence(
  state: SetupState,
  run: AwsCommandRunner,
  env: PathEnvironment = process.env,
): Effect.Effect<
  PreFinalizeAbsenceEvidence,
  AwsCommandError | SetupCommandError | SetupStoreError,
  SetupStoreService
> {
  return Effect.gen(function* () {
    let outputs: Record<string, string>;
    try {
      outputs = stackOutputs(state);
    } catch (error) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    const topicArn = String(outputs.FeedbackTopicArn ?? "");
    if (!topicArn) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "Stored stack outputs are missing FeedbackTopicArn.",
        }),
      );
    }
    const store = yield* SetupStore;
    const deployment = yield* store.loadDeploymentEnv(state.installationId, env);
    const feedbackAllowlist = deployment.NUSEND_SES_FEEDBACK_TOPIC_ARNS
      ? unwrapEnvValue(deployment.NUSEND_SES_FEEDBACK_TOPIC_ARNS).trim()
      : "";
    if (feedbackAllowlist !== topicArn) {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "Finalize is blocked: the deployed topic allowlist does not exactly match the stack-owned feedback topic.",
        }),
      );
    }
    if (state.stages.deploy?.status !== "complete") {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "Finalize is blocked until the healthy deploy stage is checkpointed.",
        }),
      );
    }
    const subscriptions = yield* listTopicSubscriptions(run, topicArn);
    const https = subscriptions.filter((entry) => entry.protocol === "https");
    if (https.length > 0) {
      const states = https.map((entry) =>
        entry.subscriptionArn.toLowerCase().includes("pending") ? "pending" : "confirmed",
      );
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Finalize is blocked: ${https.length} pre-existing HTTPS subscription(s) exist (${states.join(", ")}). Resolve the pending/duplicate/wrong endpoint manually; the coordinator will not create another.`,
        }),
      );
    }
    return {
      verified: true as const,
      topicArn,
      expectedEndpoint: expectedWebhookEndpoint(state),
      httpsCount: 0 as const,
    };
  });
}

/**
 * Require exactly one confirmed exact HTTPS subscription and exact CF-owned attributes.
 * Uses Effect.sleep for bounded confirmation polling (TestClock-friendly).
 */
export function verifyFinalizedSubscription(
  state: SetupState,
  run: AwsCommandRunner,
  options: { readonly attempts?: number } = {},
): Effect.Effect<FinalizedSubscriptionEvidence, AwsCommandError | SetupCommandError> {
  return Effect.gen(function* () {
    let outputs: Record<string, string>;
    try {
      outputs = stackOutputs(state);
    } catch (error) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    const topicArn = String(outputs.FeedbackTopicArn ?? "");
    const dlqArn = String(outputs.DlqArn ?? "");
    const expectedEndpoint = expectedWebhookEndpoint(state);
    if (!topicArn || !dlqArn) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "Stack outputs are missing feedback topic or DLQ ARN.",
        }),
      );
    }
    const attempts = Number(options.attempts ?? SUBSCRIPTION_POLL_ATTEMPTS);
    let subscriptions: readonly SnsSubscription[] = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      subscriptions = yield* listTopicSubscriptions(run, topicArn);
      const https = subscriptions.filter((entry) => entry.protocol === "https");
      if (https.length > 1) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: `Expected one HTTPS subscription; found ${https.length}. Resolve duplicates manually.`,
          }),
        );
      }
      if (https.length === 1 && !https[0]!.subscriptionArn.toLowerCase().includes("pending")) {
        break;
      }
      if (https.length === 1 && https[0]!.endpoint !== expectedEndpoint) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: `HTTPS subscription endpoint is ${https[0]!.endpoint}, expected ${expectedEndpoint}.`,
          }),
        );
      }
      if (attempt < attempts) {
        yield* Effect.sleep(SUBSCRIPTION_POLL_INTERVAL);
      }
    }
    const https = subscriptions.filter((entry) => entry.protocol === "https");
    if (https.length !== 1) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Expected exactly one HTTPS subscription after finalization; found ${https.length}.`,
        }),
      );
    }
    const subscription = https[0]!;
    if (subscription.owner !== state.config.awsAccountId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `HTTPS subscription owner is ${subscription.owner || "unknown"}, expected account ${state.config.awsAccountId}.`,
        }),
      );
    }
    if (subscription.endpoint !== expectedEndpoint) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `HTTPS subscription endpoint is ${subscription.endpoint}, expected ${expectedEndpoint}.`,
        }),
      );
    }
    if (subscription.subscriptionArn.toLowerCase().includes("pending")) {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "The exact HTTPS subscription is still PendingConfirmation. Inspect Nusend/Caddy logs, TLS, and the topic allowlist; do not create another subscription.",
        }),
      );
    }
    const result = yield* run([
      "sns",
      "get-subscription-attributes",
      "--subscription-arn",
      subscription.subscriptionArn,
      "--output",
      "json",
    ]);
    const attrsPayload = yield* decodeAwsJson(
      SnsSubscriptionAttributesResultSchema,
      result.stdout,
      "sns get-subscription-attributes",
    );
    let attrs: SubscriptionAttributes;
    try {
      attrs = parseSubscriptionAttributes(attrsPayload);
    } catch (error) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (
      attrs.protocol !== "https" ||
      attrs.endpoint !== expectedEndpoint ||
      attrs.pending ||
      attrs.rawMessageDelivery !== "false" ||
      attrs.redriveArn !== dlqArn
    ) {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "Finalized subscription has wrong endpoint, confirmation, raw-delivery, or redrive state. Refusing to accept it.",
        }),
      );
    }
    return {
      verified: true as const,
      topicArn,
      subscriptionArn: subscription.subscriptionArn,
      endpoint: expectedEndpoint,
      rawMessageDelivery: false as const,
      dlqArn,
    };
  });
}

// Silence unused Terminal import if tree-shaken — keep type available for T6.
export type SubscriptionServices = SetupStoreService | TerminalService;
