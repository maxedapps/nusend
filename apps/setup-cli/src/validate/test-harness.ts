import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Layer } from "effect";

import { AwsCliLiveWithEnv } from "../auth/aws-cli.ts";
import { PUBLIC_REPO_URL } from "../deploy/constants.ts";
import { composeYamlFixture, opensshJoinedRemote, PLANNED_SHA } from "../deploy/test-harness.ts";
import { ProcessFailedError } from "../errors.ts";
import {
  ProcessRunnerFake,
  type ProcessResult,
  type ProcessRunnerError,
  type RunCapturedOptions,
} from "../process-runner.ts";
import { SetupStore, SetupStoreLive } from "../services/setup-store.ts";
import { TerminalFake } from "../terminal.ts";
import {
  assertAwsProfileRegion,
  createChangeSetDescription,
  fakeConfigureResponse,
  readyIdentity,
  sampleAwsAuth,
  sampleOutputs as awsSampleOutputs,
  stackIdFor,
} from "../aws/test-harness.ts";
import { CLI_PATH } from "./constants.ts";
import type { ValidateWorkflowError, ValidateWorkflowServices } from "./ops.ts";
import { BASE_REQUIRED_READINESS_IDS, MARKETING_REQUIRED_READINESS_IDS } from "./constants.ts";

export const temporaryDirectories: string[] = [];
export const ACCOUNT = "123456789012";
export const REGION = "us-east-1";
export const STACK_ID = stackIdFor("nusend-prod");
export const FEEDBACK_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:nusend-prod-ses-events`;
export const ALARM_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:nusend-prod-ops-alarms`;
export const DLQ_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:nusend-prod-ses-webhook-dlq`;
export const DLQ_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/nusend-prod-ses-webhook-dlq`;
export const SUBSCRIPTION_ARN = `${FEEDBACK_TOPIC}:subscription-id`;
export const ALARM_SUBSCRIPTION_ARN = `${ALARM_TOPIC}:email-id`;
export const DEPLOY_SHA = PLANNED_SHA;

export function testEnv(): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-cli-validate-"));
  temporaryDirectories.push(directory);
  return {
    ...process.env,
    NUSEND_SETUP_HOME: directory,
    HOME: directory,
  };
}

export function cleanupTemps(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function ok(stdout: string, exitCode = 0, stderr = "", argv: string[] = []): ProcessResult {
  return { exitCode, signal: null, stdout, stderr, argv };
}

export function sampleOutputs(overrides: Record<string, string> = {}) {
  return {
    ...awsSampleOutputs(),
    FeedbackTopicArn: FEEDBACK_TOPIC,
    AlarmTopicArn: ALARM_TOPIC,
    DlqArn: DLQ_ARN,
    DlqUrl: DLQ_URL,
    DlqName: "nusend-prod-ses-webhook-dlq",
    RuntimeUserName: "nusend-prod-runtime",
    ...overrides,
  };
}

export function expectedEndpoint(domain = "mail.example.com") {
  return `https://${domain}/api/webhooks/aws/sns/ses`;
}

export function confirmedSubscription(endpoint = expectedEndpoint()) {
  return {
    Protocol: "https",
    Endpoint: endpoint,
    SubscriptionArn: SUBSCRIPTION_ARN,
    Owner: ACCOUNT,
  };
}

export function readinessPayload(
  final = false,
  marketing = false,
  options: { feedbackOk?: boolean } = {},
) {
  const ids = [
    ...BASE_REQUIRED_READINESS_IDS,
    ...(marketing ? MARKETING_REQUIRED_READINESS_IDS : []),
    ...(final ? ["operations.latest_feedback"] : []),
  ];
  return {
    status: "ok",
    expectedWebhookUrl: expectedEndpoint(),
    checks: ids.map((id) => ({
      id,
      status:
        id === "operations.latest_feedback" && options.feedbackOk === false ? "warning" : "ok",
    })),
  };
}

export function suppressionPayload(reason: "bounce" | "complaint", missing = false) {
  const email =
    reason === "bounce" ? "bounce@simulator.amazonses.com" : "complaint@simulator.amazonses.com";
  return {
    items: missing
      ? []
      : [
          {
            email,
            scope: "all",
            reason,
          },
        ],
  };
}

export function simulatorStdout(scenario: string) {
  return `${JSON.stringify({
    status: "validated",
    runId: `run-${scenario}`,
    recipientEmail: `${scenario}@simulator.amazonses.com`,
  })}\n`;
}

export type FakeValidateOptions = {
  calls?: Array<{ argv: string[]; stdin?: string }>;
  stsAccount?: string;
  accessDeniedOn?: string;
  expiredSessionOn?: string;
  stackExists?: boolean;
  stackStatus?: string;
  stackId?: string;
  stackOutputs?: Record<string, string>;
  feedbackSubscriptions?: Record<string, unknown>[];
  alarmSubscriptions?: Record<string, unknown>[];
  alarmPending?: boolean;
  dlqCounters?: { visible: number; notVisible: number; delayed: number };
  identity?: Record<string, unknown>;
  account?: Record<string, unknown>;
  readiness?: unknown;
  readinessExitCode?: number;
  readinessStderr?: string;
  missingSuppression?: "bounce" | "complaint";
  readinessFeedbackOk?: boolean;
  marketingEnabled?: boolean;
  driftFail?: boolean;
  providerNoise?: string;
  sshUnreachable?: boolean;
};

export function fakeValidateRunCaptured(options: FakeValidateOptions = {}) {
  const calls = options.calls ?? [];
  const dlq = options.dlqCounters ?? { visible: 0, notVisible: 0, delayed: 0 };
  const feedbackSubs = options.feedbackSubscriptions ?? [confirmedSubscription()];
  const alarmSubs = options.alarmSubscriptions ?? [
    {
      Protocol: "email",
      Endpoint: "alerts@example.com",
      SubscriptionArn: options.alarmPending ? "PendingConfirmation" : ALARM_SUBSCRIPTION_ARN,
      Owner: ACCOUNT,
    },
  ];

  return (runOptions: RunCapturedOptions): Effect.Effect<ProcessResult, ProcessRunnerError> =>
    Effect.gen(function* () {
      const argv = [runOptions.command, ...(runOptions.args ?? [])];
      calls.push({ argv, stdin: runOptions.stdin });
      const joined = argv.join(" ");

      const finish = (result: ProcessResult): Effect.Effect<ProcessResult, ProcessFailedError> => {
        if (result.exitCode !== 0 && !runOptions.allowNonZero) {
          return Effect.fail(
            new ProcessFailedError({
              exitCode: result.exitCode,
              argv,
              stdout: result.stdout,
              stderr: result.stderr,
              message: `Command failed (${result.exitCode}): ${argv.join(" ")}\n${result.stderr || result.stdout}`,
            }),
          );
        }
        return Effect.succeed(result);
      };

      if (runOptions.command === CLI_PATH || argv[0] === CLI_PATH) {
        const args = runOptions.args ?? [];
        if (args.includes("readiness")) {
          if (options.readinessExitCode && options.readinessExitCode !== 0) {
            return yield* finish(
              ok("", options.readinessExitCode, options.readinessStderr ?? "error", argv),
            );
          }
          if (typeof options.readiness === "string") {
            return yield* finish(ok(options.readiness, 0, "", argv));
          }
          return yield* finish(
            ok(
              JSON.stringify(
                options.readiness ??
                  readinessPayload(false, options.marketingEnabled === true, {
                    feedbackOk: options.readinessFeedbackOk,
                  }),
              ),
              0,
              "",
              argv,
            ),
          );
        }
        if (args.includes("suppressions")) {
          const reasonIdx = args.indexOf("--reason");
          const reason = String(args[reasonIdx + 1] ?? "bounce") as "bounce" | "complaint";
          const missing = options.missingSuppression === reason;
          return yield* finish(
            ok(JSON.stringify(suppressionPayload(reason, missing)), 0, "", argv),
          );
        }
        return yield* finish(ok("{}", 0, "", argv));
      }

      if (runOptions.command === "git" && runOptions.args?.[0] === "ls-remote") {
        return yield* finish(ok(`${DEPLOY_SHA}\trefs/tags/v0.1.1\n`, 0, "", argv));
      }

      if (runOptions.command === "curl") {
        const url = runOptions.args?.[runOptions.args.length - 1] ?? "";
        if (url.endsWith("/health/db")) return yield* finish(ok("404", 0, "", argv));
        if (url.endsWith("/health")) return yield* finish(ok("200", 0, "", argv));
        return yield* Effect.die(new Error(`unexpected curl ${joined}`));
      }

      if (runOptions.command === "ssh") {
        if (options.sshUnreachable) {
          return yield* finish(
            ok("", 255, "ssh: connect to host 203.0.113.10 port 22: Connection refused", argv),
          );
        }
        const remote = opensshJoinedRemote(argv);
        if (remote.includes("simulator-main.ts")) {
          const scenario = remote.includes(" success ")
            ? "success"
            : remote.includes(" bounce ")
              ? "bounce"
              : remote.includes(" complaint ")
                ? "complaint"
                : "unknown";
          return yield* finish(ok(simulatorStdout(scenario), 0, "", argv));
        }
        if (remote.includes("remote get-url origin")) {
          return yield* finish(
            ok(
              [
                `ORIGIN:${PUBLIC_REPO_URL}`,
                "PORCELAIN:",
                `HEAD:${DEPLOY_SHA}`,
                "BRANCH:",
                `TAG_SHA:${DEPLOY_SHA}`,
              ].join("\n") + "\n",
              0,
              "",
              argv,
            ),
          );
        }
        if (remote.includes("docker compose ps --format json")) {
          const services = [
            { Service: "api", State: "running", Health: "healthy" },
            { Service: "worker", State: "running", Status: "Up" },
            { Service: "caddy", State: "running", Health: "healthy" },
            { Service: "backup", State: "running", Health: "healthy" },
          ];
          return yield* finish(
            ok(services.map((entry) => JSON.stringify(entry)).join("\n") + "\n", 0, "", argv),
          );
        }
        if (remote.includes("docker image inspect") || remote.includes("cat compose.yaml")) {
          if (remote.includes("cat compose.yaml")) {
            return yield* finish(ok(composeYamlFixture(), 0, "", argv));
          }
          return yield* finish(ok(`${DEPLOY_SHA}\n`, 0, "", argv));
        }
        if (remote.includes("health/db")) return yield* finish(ok("", 0, "", argv));
        return yield* finish(ok("", 0, "", argv));
      }

      if (runOptions.command !== "aws") {
        return yield* Effect.die(new Error(`unexpected command ${joined}`));
      }

      const args = runOptions.args ?? [];
      const configure = fakeConfigureResponse(args);
      if (configure) return yield* finish(configure);

      assertAwsProfileRegion(args);

      if (options.expiredSessionOn && args.join(" ").includes(options.expiredSessionOn)) {
        return yield* finish(
          ok("", 255, "Error when retrieving token from sso: Token has expired and refresh failed"),
        );
      }
      if (options.accessDeniedOn && args.join(" ").includes(options.accessDeniedOn)) {
        return yield* finish(
          ok("", 255, "An error occurred (AccessDenied) when calling the operation"),
        );
      }

      if (args[0] === "sts" && args[1] === "get-caller-identity") {
        const account = options.stsAccount ?? ACCOUNT;
        return yield* finish(
          ok(
            JSON.stringify({
              Account: account,
              Arn: `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_NusendProvisioner_ab12cd/user`,
            }),
          ),
        );
      }

      if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
        if (options.stackExists === false) {
          return yield* finish(ok("", 255, "Stack with id nusend-prod does not exist"));
        }
        const outputs = Object.entries(options.stackOutputs ?? sampleOutputs()).map(
          ([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }),
        );
        return yield* finish(
          ok(
            JSON.stringify({
              Stacks: [
                {
                  StackId: options.stackId ?? STACK_ID,
                  StackName: "nusend-prod",
                  StackStatus: options.stackStatus ?? "UPDATE_COMPLETE",
                  Outputs: outputs,
                  LastUpdatedTime: "2026-01-01T00:00:00.000Z",
                },
              ],
            }),
          ),
        );
      }

      if (args[0] === "cloudformation" && args[1] === "detect-stack-drift") {
        if (options.driftFail) {
          return yield* finish(ok("", 255, options.providerNoise ?? "drift-noise"));
        }
        return yield* finish(ok(JSON.stringify({ StackDriftDetectionId: "drift-1" })));
      }
      if (
        args[0] === "cloudformation" &&
        args[1] === "wait" &&
        args[2] === "stack-drift-detection-complete"
      ) {
        return yield* finish(ok(""));
      }
      if (args[0] === "cloudformation" && args[1] === "describe-stack-drift-detection-status") {
        return yield* finish(
          ok(
            JSON.stringify({
              DetectionStatus: "DETECTION_COMPLETE",
              StackDriftStatus: "IN_SYNC",
            }),
          ),
        );
      }
      if (args[0] === "cloudformation" && args[1] === "describe-stack-resource-drifts") {
        return yield* finish(ok(JSON.stringify({ StackResourceDrifts: [] })));
      }

      if (args[0] === "sns" && args[1] === "list-subscriptions-by-topic") {
        const topicIdx = args.indexOf("--topic-arn");
        const topic = String(args[topicIdx + 1] ?? "");
        const subscriptions =
          topic === ALARM_TOPIC || topic.includes("ops-alarms") || topic.includes("alarms")
            ? alarmSubs
            : feedbackSubs;
        return yield* finish(ok(JSON.stringify({ Subscriptions: subscriptions })));
      }

      if (args[0] === "sns" && args[1] === "get-subscription-attributes") {
        const arnIdx = args.indexOf("--subscription-arn");
        const arn = String(args[arnIdx + 1] ?? "");
        if (arn.includes("email") || arn === ALARM_SUBSCRIPTION_ARN) {
          return yield* finish(
            ok(
              JSON.stringify({
                Attributes: {
                  Endpoint: "alerts@example.com",
                  Protocol: "email",
                  PendingConfirmation: options.alarmPending ? "true" : "false",
                  Owner: ACCOUNT,
                },
              }),
            ),
          );
        }
        return yield* finish(
          ok(
            JSON.stringify({
              Attributes: {
                Endpoint: expectedEndpoint(),
                Protocol: "https",
                PendingConfirmation: "false",
                RawMessageDelivery: "false",
                Owner: ACCOUNT,
                RedrivePolicy: JSON.stringify({ deadLetterTargetArn: DLQ_ARN }),
              },
            }),
          ),
        );
      }

      if (args[0] === "sqs" && args[1] === "get-queue-attributes") {
        return yield* finish(
          ok(
            JSON.stringify({
              Attributes: {
                ApproximateNumberOfMessages: String(dlq.visible),
                ApproximateNumberOfMessagesNotVisible: String(dlq.notVisible),
                ApproximateNumberOfMessagesDelayed: String(dlq.delayed),
              },
            }),
          ),
        );
      }

      if (args[0] === "cloudwatch" && args[1] === "describe-alarms") {
        const prefix = "nusend-prod-";
        const alarms = [
          ["sns-notifications-failed", "NumberOfNotificationsFailed"],
          ["sns-redriven-to-dlq", "NumberOfNotificationsRedrivenToDlq"],
          ["sns-redrive-failed", "NumberOfNotificationsFailedToRedriveToDlq"],
          ["dlq-visible-messages", "ApproximateNumberOfMessagesVisible"],
        ].map(([suffix, metric]) => ({
          AlarmName: `${prefix}${suffix}`,
          MetricName: metric,
          AlarmActions: [ALARM_TOPIC],
          StateValue: "OK",
        }));
        return yield* finish(ok(JSON.stringify({ MetricAlarms: alarms })));
      }

      if (args[0] === "sesv2" && args[1] === "get-email-identity") {
        return yield* finish(ok(JSON.stringify(options.identity ?? readyIdentity())));
      }
      if (args[0] === "sesv2" && args[1] === "get-account") {
        return yield* finish(
          ok(
            JSON.stringify(
              options.account ?? {
                ProductionAccessEnabled: true,
                Details: { ReviewDetails: { Status: "GRANTED" } },
              },
            ),
          ),
        );
      }

      if (args[0] === "cloudformation" && args[1] === "describe-change-set") {
        return yield* finish(
          ok(
            JSON.stringify(
              createChangeSetDescription({
                changeSetArn: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/x/y",
                status: "CREATE_COMPLETE",
                changes: [],
              }),
            ),
          ),
        );
      }

      return yield* Effect.die(new Error(`unexpected aws argv: ${argv.join(" ")}`));
    });
}

export function validateLayer(
  env: NodeJS.ProcessEnv,
  fake: FakeValidateOptions = {},
  terminalAnswers: readonly string[] = [],
) {
  const calls = fake.calls ?? [];
  fake.calls = calls;
  const terminal = TerminalFake({ answers: terminalAnswers });
  const processLayer = ProcessRunnerFake({
    runCaptured: fakeValidateRunCaptured(fake),
  });
  const layer = Layer.mergeAll(
    SetupStoreLive,
    terminal.layer,
    processLayer,
    AwsCliLiveWithEnv(env).pipe(Layer.provide(processLayer)),
  ) as Layer.Layer<ValidateWorkflowServices>;
  return { layer, terminal, calls };
}

export async function runValidateWorkflow<A>(
  effect: Effect.Effect<A, ValidateWorkflowError, ValidateWorkflowServices>,
  layer: Layer.Layer<ValidateWorkflowServices>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

export async function runValidateWorkflowExit<A>(
  effect: Effect.Effect<A, ValidateWorkflowError, ValidateWorkflowServices>,
  layer: Layer.Layer<ValidateWorkflowServices>,
): Promise<Exit.Exit<A, ValidateWorkflowError>> {
  return Effect.runPromiseExit(effect.pipe(Effect.provide(layer)));
}

export async function seedFixture(
  env: NodeJS.ProcessEnv,
  options: {
    stages?: string[];
    marketingEnabled?: boolean;
    productionGatesComplete?: boolean;
    alarmExercised?: boolean;
    finalizePhase?: boolean;
  } = {},
) {
  const now = "2026-01-01T00:00:00.000Z";
  const stages = options.stages ?? [
    "aws_core",
    "human_gates",
    "deploy",
    "aws_finalize",
    "validate_pre_simulator",
    "validate_simulator",
  ];
  const stageMap: Record<string, unknown> = {
    init: { status: "complete", completedAt: now, evidence: { verified: true } },
  };
  for (const stage of stages) {
    if (stage === "validate_simulator") {
      stageMap[stage] = {
        status: "complete",
        completedAt: now,
        evidence: {
          verified: true,
          scenarios: ["success", "bounce", "complaint"].map((scenario) => ({
            scenario,
            status: "validated",
            runId: `run-${scenario}`,
            recipientEmail: `${scenario}@simulator.amazonses.com`,
          })),
        },
      };
      continue;
    }
    stageMap[stage] = { status: "complete", completedAt: now, evidence: { verified: true } };
  }

  const productionGates: Record<string, unknown> = {};
  if (options.productionGatesComplete) {
    for (const id of [
      "backup_restore",
      "reboot_recovery",
      "gmail_headers",
      "dmarc",
      "quota_ramp",
      "provider_firewall",
    ]) {
      productionGates[id] = { verified: true, completedAt: now };
    }
  }

  const validationPlan: Record<string, unknown> = {};
  if (options.alarmExercised || options.productionGatesComplete) {
    validationPlan.alarmExercise = {
      verified: true,
      completedAt: now,
      alertEmail: "alerts@example.com",
    };
  }
  if (Object.keys(productionGates).length > 0) {
    validationPlan.productionGates = productionGates;
  }

  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      yield* store.writeState(
        {
          schemaVersion: 2 as const,
          installationId: "prod",
          createdAt: now,
          updatedAt: now,
          awsAuth: sampleAwsAuth(),
          config: {
            releaseTag: "v0.1.1",
            domain: "mail.example.com",
            ingressMode: "direct" as const,
            ownerEmail: "owner@example.com",
            ownerName: "Owner",
            awsProfile: "nusend-provisioner",
            awsRegion: REGION,
            awsAccountId: ACCOUNT,
            sesIdentity: "example.com",
            sesFromEmail: "sender@example.com",
            marketingEnabled: options.marketingEnabled === true,
            trackingEnabled: false,
            alertEmail: "alerts@example.com",
            route53HostedZoneId: null,
            sshTarget: "root@203.0.113.10",
            remotePath: "/srv/nusend",
            installationName: "prod",
          },
          stages: stageMap as never,
          plans: Object.keys(validationPlan).length ? { validation: validationPlan } : {},
          deploy: {
            commitSha: DEPLOY_SHA,
            releaseTag: "v0.1.1",
            sshTarget: "root@203.0.113.10",
            remotePath: "/srv/nusend",
            domain: "mail.example.com",
            appImage: "ghcr.io/maxedapps/nusend:v0.1.1",
            backupImage: "ghcr.io/maxedapps/nusend-backup:v0.1.1",
            appliedAt: now,
            fingerprint: "b".repeat(64),
          },
          aws: {
            runtimeAccessKeyId: "AKIARUNTIME000000001",
            stackCreation: {
              provenance: "coordinator-reviewed-change-set",
              phase: "core",
              changeSetType: "CREATE",
              stackId: STACK_ID,
              stackName: "nusend-prod",
              accountId: ACCOUNT,
              partition: "aws",
              region: REGION,
              changeSetArn: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:changeSet/nusend-prod-core/create-id`,
              fingerprint: "a".repeat(64),
              appliedAt: now,
            },
            stack: {
              stackId: STACK_ID,
              stackName: "nusend-prod",
              accountId: ACCOUNT,
              partition: "aws",
              region: REGION,
              phase: options.finalizePhase === false ? "core" : "finalize",
              status: "UPDATE_COMPLETE",
              outputs: sampleOutputs(),
              appliedAt: now,
            },
            productionAccess: {
              productionAccessEnabled: true,
              status: "granted",
              reviewStatus: "GRANTED",
            },
          },
        } as never,
        env,
      );
      yield* store.writeDeploymentEnv(
        "prod",
        {
          NUSEND_DOMAIN: "mail.example.com",
          NUSEND_INGRESS_MODE: "direct",
          NUSEND_OWNER_EMAIL: "owner@example.com",
          NUSEND_OWNER_NAME: "Owner",
          BETTER_AUTH_SECRET: "better-auth-secret-value-xxxxxxxx",
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret-value",
          NUSEND_API_KEY_HASH_SECRET: "api-key-hash-secret-value-xxxxxx",
          NUSEND_UNSUBSCRIBE_SECRET: "unsubscribe-secret-value-xxxxxx",
          AWS_ACCESS_KEY_ID: "AKIARUNTIME000000001",
          AWS_SECRET_ACCESS_KEY: "runtime-secret-value-xxxxxxxx",
          AWS_REGION: REGION,
          NUSEND_SES_FROM_EMAIL: "sender@example.com",
          NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "nusend-prod-transactional",
          NUSEND_SES_FEEDBACK_TOPIC_ARNS: FEEDBACK_TOPIC,
          NUSEND_RESTIC_REPOSITORY: "s3:https://abc.r2.cloudflarestorage.com/bucket/nusend",
          NUSEND_R2_ACCESS_KEY_ID: "r2-access",
          NUSEND_R2_SECRET_ACCESS_KEY: "r2-secret-value-xxxxxx",
          NUSEND_RESTIC_PASSWORD: "restic-password-value-xxxxxx",
        },
        env,
      );
      yield* store.writeCurrentPointer("prod", env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}
