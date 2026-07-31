import { Clock, Effect, Schema } from "effect";

import { AwsCommandError } from "../aws/errors.ts";
import { type AwsWorkflowError, type AwsWorkflowServices } from "../aws/ops.ts";
import { decodeAwsJson } from "../aws/schemas.ts";
import {
  listTopicSubscriptions,
  stackOutputs,
  type AwsCommandRunner,
} from "../aws/subscription.ts";
import {
  CancellationError,
  ProcessFailedError,
  ProcessSignalError,
  ProcessStartError,
  SetupCommandError,
  SetupStoreError,
} from "../errors.ts";
import { ProcessRunner, redactText, type ProcessRunnerService } from "../process-runner.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import { secretValuesFromEnv } from "../state/env.ts";
import type { PathEnvironment } from "../state/paths.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { SetupState } from "../state/schema.ts";
import { CLI_PATH, EXPECTED_ALARMS, VALIDATION_PLAN_KEY } from "./constants.ts";
import { parseCounter } from "./pure.ts";

export type ValidateWorkflowError =
  | AwsWorkflowError
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError;

export type ValidateWorkflowServices = AwsWorkflowServices | ProcessRunnerService;

const QueueAttributesSchema = Schema.Struct({
  Attributes: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const CloudWatchAlarmsSchema = Schema.Struct({
  MetricAlarms: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});

export { QueueAttributesSchema, CloudWatchAlarmsSchema };

export function readDlqCounters(
  state: SetupState,
  run: AwsCommandRunner,
): Effect.Effect<
  { visible: number; notVisible: number; delayed: number },
  AwsCommandError | SetupCommandError
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
    const url = String(outputs.DlqUrl ?? "");
    if (!url) {
      return yield* Effect.fail(
        new SetupCommandError({ message: "Stack outputs are missing DlqUrl." }),
      );
    }
    const result = yield* run([
      "sqs",
      "get-queue-attributes",
      "--queue-url",
      url,
      "--attribute-names",
      "ApproximateNumberOfMessages",
      "ApproximateNumberOfMessagesNotVisible",
      "ApproximateNumberOfMessagesDelayed",
      "--output",
      "json",
    ]);
    const payload = yield* decodeAwsJson(
      QueueAttributesSchema,
      result.stdout,
      "sqs get-queue-attributes",
    );
    const attrs = payload.Attributes;
    if (attrs == null || typeof attrs !== "object") {
      return yield* Effect.fail(
        new SetupCommandError({ message: "SQS queue attributes are malformed." }),
      );
    }
    try {
      return {
        visible: parseCounter(attrs.ApproximateNumberOfMessages, "ApproximateNumberOfMessages"),
        notVisible: parseCounter(
          attrs.ApproximateNumberOfMessagesNotVisible,
          "ApproximateNumberOfMessagesNotVisible",
        ),
        delayed: parseCounter(
          attrs.ApproximateNumberOfMessagesDelayed,
          "ApproximateNumberOfMessagesDelayed",
        ),
      };
    } catch (error) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
}

export function verifyAlarmsAndEmail(
  state: SetupState,
  run: AwsCommandRunner,
): Effect.Effect<
  {
    verified: true;
    alarmTopicArn: string;
    alertEmail: string;
    emailSubscriptionArn: string;
    alarmCount: number;
  },
  AwsCommandError | SetupCommandError
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
    const alarmTopicArn = String(outputs.AlarmTopicArn ?? "");
    const feedbackTopicArn = String(outputs.FeedbackTopicArn ?? "");
    if (!alarmTopicArn || alarmTopicArn === feedbackTopicArn) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "Dedicated alarm topic is missing or equals the SES feedback topic.",
        }),
      );
    }
    const subscriptions = yield* listTopicSubscriptions(run, alarmTopicArn);
    const emailSubscriptions = subscriptions.filter((entry) => entry.protocol === "email");
    const expected = emailSubscriptions.filter(
      (entry) => entry.endpoint === state.config.alertEmail,
    );
    if (emailSubscriptions.length !== 1 || expected.length !== 1) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Expected exactly one alarm email subscription, for ${state.config.alertEmail}; found ${emailSubscriptions.length} email subscription(s) and ${expected.length} exact match(es).`,
        }),
      );
    }
    if (expected[0]!.owner !== state.config.awsAccountId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Alarm email subscription owner is ${expected[0]!.owner || "unknown"}, expected account ${state.config.awsAccountId}.`,
        }),
      );
    }
    if (expected[0]!.subscriptionArn.toLowerCase().includes("pending")) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Alarm email subscription for ${state.config.alertEmail} is PendingConfirmation. Open the AWS confirmation email, then rerun continue.`,
        }),
      );
    }

    const prefix = `nusend-${state.config.installationName ?? state.installationId}-`;
    const result = yield* run([
      "cloudwatch",
      "describe-alarms",
      "--alarm-name-prefix",
      prefix,
      "--output",
      "json",
    ]);
    const payload = yield* decodeAwsJson(
      CloudWatchAlarmsSchema,
      result.stdout,
      "cloudwatch describe-alarms",
    );
    const alarms = Array.isArray(payload.MetricAlarms) ? payload.MetricAlarms : [];
    if (alarms.length !== EXPECTED_ALARMS.length) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Expected exactly ${EXPECTED_ALARMS.length} dedicated CloudWatch metric alarms; found ${alarms.length}.`,
        }),
      );
    }
    for (const [suffix, metric] of EXPECTED_ALARMS) {
      const match = alarms.filter(
        (alarm) => alarm?.AlarmName === `${prefix}${suffix}` && alarm?.MetricName === metric,
      );
      if (match.length !== 1) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: `Expected one CloudWatch alarm ${prefix}${suffix}.`,
          }),
        );
      }
      const actions = Array.isArray(match[0]!.AlarmActions)
        ? (match[0]!.AlarmActions as unknown[]).map(String)
        : [];
      if (
        actions.length !== 1 ||
        actions[0] !== alarmTopicArn ||
        actions.includes(feedbackTopicArn)
      ) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: `Alarm ${prefix}${suffix} must use only the dedicated alarm topic action.`,
          }),
        );
      }
    }
    return {
      verified: true as const,
      alarmTopicArn,
      alertEmail: state.config.alertEmail,
      emailSubscriptionArn: expected[0]!.subscriptionArn,
      alarmCount: EXPECTED_ALARMS.length,
    };
  });
}

export function writeValidationPlan(
  state: SetupState,
  patch: Record<string, unknown>,
  env: PathEnvironment,
): Effect.Effect<void, SetupStoreError, SetupStoreService> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    const latest = yield* store.loadState(state.installationId, env);
    yield* store.writeState(
      {
        ...latest,
        updatedAt: now,
        plans: {
          ...latest.plans,
          [VALIDATION_PLAN_KEY]: sanitizePlanMetadata({
            ...(latest.plans?.[VALIDATION_PLAN_KEY] ?? {}),
            ...patch,
            updatedAt: now,
          }),
        },
      },
      env,
    );
  });
}

export function runBuiltCliJson(
  state: SetupState,
  args: readonly string[],
  env: PathEnvironment,
  cliPath: string = CLI_PATH,
): Effect.Effect<
  unknown,
  | SetupCommandError
  | SetupStoreError
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError
  | CancellationError,
  SetupStoreService | ProcessRunnerService
> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const secrets = yield* store.loadDeploymentEnv(state.installationId, env).pipe(
      Effect.map((deployment) => secretValuesFromEnv(deployment)),
      Effect.catchTag("SetupStoreError", () => Effect.succeed([] as string[])),
    );

    const runner = yield* ProcessRunner;
    const result = yield* runner
      .runCaptured({
        command: cliPath,
        args: ["--json", ...args],
        allowNonZero: true,
        redact: secrets,
      })
      .pipe(
        Effect.catchTag("ProcessStartError", (error) =>
          Effect.fail(
            new SetupCommandError({
              message:
                "Built Nusend CLI is absent or not executable. Run `pnpm --filter @nusend/cli build`, then `apps/cli/dist/main.js --json login https://" +
                state.config.domain +
                "`." +
                (error.message ? ` (${error.message})` : ""),
            }),
          ),
        ),
      );

    if (result.exitCode !== 0) {
      const detail = redactText(result.stderr || result.stdout, secrets);
      if (result.exitCode === 3 || /unauthenticated|authentication required|login/iu.test(detail)) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: `Built Nusend CLI is unauthenticated. Run \`${cliPath} --json login https://${state.config.domain}\`, then rerun validation.`,
          }),
        );
      }
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Built Nusend CLI failed (${result.exitCode}): ${detail}`,
        }),
      );
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return yield* Effect.fail(
        new SetupCommandError({ message: "Built Nusend CLI returned malformed JSON." }),
      );
    }
  });
}
