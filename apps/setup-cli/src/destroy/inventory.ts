import { Cause, Effect, Exit, Option, Schema } from "effect";

import { AwsCommandError } from "../aws/errors.ts";
import { decodeAwsJson } from "../aws/schemas.ts";
import {
  listTopicSubscriptions,
  parseSubscriptionAttributes,
  type AwsCommandRunner,
} from "../aws/subscription.ts";
import { inspectExistingCheckout, posixSingleQuote, runSsh } from "../deploy/index.ts";
import { SetupCommandError } from "../errors.ts";
import type { ProcessRunnerService } from "../process-runner.ts";
import type { SetupState } from "../state/schema.ts";
import { exactDeployEvidence, isSshUnreachable, stableSort } from "./pure.ts";

const StackResourcesSchema = Schema.Struct({
  StackResourceSummaries: Schema.optional(
    Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  ),
});

const AccessKeysSchema = Schema.Struct({
  AccessKeyMetadata: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});

const AlarmsSchema = Schema.Struct({
  MetricAlarms: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});

function causeMessage(cause: Cause.Cause<unknown>): string {
  const typed = Cause.findErrorOption(cause);
  if (Option.isSome(typed)) {
    return String((typed.value as { message?: string }).message ?? typed.value);
  }
  return Cause.pretty(cause);
}

export function listStackResources(
  run: AwsCommandRunner,
  stackId: string,
): Effect.Effect<
  { absent: boolean; resources: Array<Record<string, string>> },
  AwsCommandError | SetupCommandError
> {
  return Effect.gen(function* () {
    const result = yield* run(
      ["cloudformation", "list-stack-resources", "--stack-name", stackId, "--output", "json"],
      { allowNonZero: true },
    );
    if (result.exitCode !== 0) {
      if (/does not exist|not exist/iu.test(`${result.stdout}\n${result.stderr}`)) {
        return { absent: true, resources: [] };
      }
      return yield* Effect.fail(
        new SetupCommandError({
          message: `cloudformation list-stack-resources failed: ${result.stderr || result.stdout}`,
        }),
      );
    }
    const payload = yield* decodeAwsJson(
      StackResourcesSchema,
      result.stdout,
      "cloudformation list-stack-resources",
    );
    const summaries = Array.isArray(payload.StackResourceSummaries)
      ? payload.StackResourceSummaries
      : [];
    return {
      absent: false,
      resources: stableSort(
        summaries.map((item) => ({
          logicalId: String(item?.LogicalResourceId ?? ""),
          physicalId: String(item?.PhysicalResourceId ?? ""),
          type: String(item?.ResourceType ?? ""),
          status: String(item?.ResourceStatus ?? ""),
        })),
      ),
    };
  });
}

export function listRuntimeKeys(
  run: AwsCommandRunner,
  userName: string,
): Effect.Effect<
  { userExists: boolean; keys: Array<{ accessKeyId: string; status: string }> },
  AwsCommandError | SetupCommandError
> {
  return Effect.gen(function* () {
    const result = yield* run(
      ["iam", "list-access-keys", "--user-name", userName, "--output", "json"],
      { allowNonZero: true },
    );
    if (result.exitCode !== 0) {
      if (
        /NoSuchEntity|cannot be found|does not exist/iu.test(`${result.stdout}\n${result.stderr}`)
      ) {
        return { userExists: false, keys: [] };
      }
      return yield* Effect.fail(
        new SetupCommandError({
          message: `iam list-access-keys failed: ${result.stderr || result.stdout}`,
        }),
      );
    }
    const payload = yield* decodeAwsJson(AccessKeysSchema, result.stdout, "iam list-access-keys");
    if (!Array.isArray(payload.AccessKeyMetadata)) {
      return yield* Effect.fail(
        new SetupCommandError({ message: "IAM access-key inventory is malformed." }),
      );
    }
    return {
      userExists: true,
      keys: stableSort(
        payload.AccessKeyMetadata.map((key) => ({
          accessKeyId: String(key?.AccessKeyId ?? ""),
          status: String(key?.Status ?? "UNKNOWN"),
        })),
      ),
    };
  });
}

export function inventorySubscriptions(
  run: AwsCommandRunner,
  topicArn: string,
): Effect.Effect<Array<Record<string, unknown>>, AwsCommandError | SetupCommandError> {
  return Effect.gen(function* () {
    if (!topicArn) return [];
    const subscriptions = yield* listTopicSubscriptions(run, topicArn);
    const inventory: Array<Record<string, unknown>> = [];
    for (const item of subscriptions) {
      const pending = item.subscriptionArn.toLowerCase().includes("pending");
      let attributes: ReturnType<typeof parseSubscriptionAttributes> | null = null;
      if (!pending) {
        const result = yield* run([
          "sns",
          "get-subscription-attributes",
          "--subscription-arn",
          item.subscriptionArn,
          "--output",
          "json",
        ]);
        try {
          attributes = parseSubscriptionAttributes(JSON.parse(result.stdout));
        } catch (error) {
          return yield* Effect.fail(
            new SetupCommandError({
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      inventory.push({
        subscriptionArn: item.subscriptionArn,
        protocol: item.protocol,
        endpoint: item.endpoint,
        owner: item.owner,
        pending,
        rawMessageDelivery: attributes?.rawMessageDelivery ?? null,
        redriveArn: attributes?.redriveArn ?? null,
      });
    }
    return stableSort(inventory);
  });
}

export function inventoryAlarms(
  state: SetupState,
  run: AwsCommandRunner,
): Effect.Effect<Array<Record<string, unknown>>, AwsCommandError | SetupCommandError> {
  return Effect.gen(function* () {
    const prefix = `nusend-${state.config.installationName ?? state.installationId}-`;
    const result = yield* run([
      "cloudwatch",
      "describe-alarms",
      "--alarm-name-prefix",
      prefix,
      "--output",
      "json",
    ]);
    const payload = yield* decodeAwsJson(AlarmsSchema, result.stdout, "cloudwatch describe-alarms");
    const alarms = Array.isArray(payload.MetricAlarms) ? payload.MetricAlarms : [];
    return stableSort(
      alarms.map((alarm) => ({
        name: String(alarm?.AlarmName ?? ""),
        state: String(alarm?.StateValue ?? "UNKNOWN"),
        actions: Array.isArray(alarm?.AlarmActions)
          ? (alarm.AlarmActions as unknown[])
              .map(String)
              .sort((left, right) => left.localeCompare(right))
          : [],
      })),
    );
  });
}

export function inspectTrustedRemote(
  state: SetupState,
): Effect.Effect<Record<string, unknown>, never, ProcessRunnerService> {
  return Effect.gen(function* () {
    const evidence = exactDeployEvidence(state);
    if (!evidence) {
      return {
        reachable: null,
        status: "identity-unproven",
        stopReviewed: false,
        detail: "state.deploy does not contain exact target/path/domain/release/commit evidence",
      };
    }
    const checkoutExit = yield* Effect.exit(
      inspectExistingCheckout(state, evidence.remotePath, evidence.releaseTag, evidence.commitSha),
    );
    if (Exit.isFailure(checkoutExit)) {
      const detail = causeMessage(checkoutExit.cause);
      return {
        reachable: false,
        status: isSshUnreachable(new Error(detail)) ? "unreachable" : "identity-unproven",
        stopReviewed: false,
        evidence,
        detail,
      };
    }
    const resultExit = yield* Effect.exit(
      runSsh(
        state,
        `cd ${posixSingleQuote(evidence.remotePath)} && docker compose ps --format json`,
        { allowNonZero: true },
      ),
    );
    if (Exit.isFailure(resultExit)) {
      const detail = causeMessage(resultExit.cause);
      return {
        reachable: false,
        status: isSshUnreachable(new Error(detail)) ? "unreachable" : "identity-unproven",
        stopReviewed: false,
        evidence,
        detail,
      };
    }
    const result = resultExit.value;
    const lines = result.stdout.split(/\r?\n/u).filter((line) => line.trim());
    return {
      reachable: true,
      status: result.exitCode === 0 ? "inspected" : "unavailable",
      stopReviewed: true,
      evidence,
      checkout: checkoutExit.value,
      ...(result.exitCode === 0
        ? { composeEntries: lines.length }
        : { detail: "docker compose ps failed" }),
    };
  });
}
