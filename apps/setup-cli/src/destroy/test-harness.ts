import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Layer } from "effect";

import { AwsCliLiveWithEnv } from "../auth/aws-cli.ts";
import { PUBLIC_REPO_URL } from "../deploy/constants.ts";
import { opensshJoinedRemote, PLANNED_SHA } from "../deploy/test-harness.ts";
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
  fakeConfigureResponse,
  sampleAwsAuth,
  stackIdFor,
} from "../aws/test-harness.ts";
import type { DestroyWorkflowError, DestroyWorkflowServices } from "./plan.ts";
import { RETAINED_RESOURCES } from "./pure.ts";

export const temporaryDirectories: string[] = [];
export const ACCOUNT = "123456789012";
export const REGION = "us-east-1";
export const STACK_ID = stackIdFor("nusend-prod");
export const KEY_ID = "AKIARUNTIME000000001";
export const DEPLOY_SHA = "b".repeat(40);
export const FEEDBACK_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:nusend-prod-feedback`;
export const ALARM_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:nusend-prod-alarms`;
export const DLQ_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:nusend-prod-dlq`;
export const DLQ_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/nusend-prod-dlq`;

export function testEnv(): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-cli-destroy-"));
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

export function stackOutputs() {
  return {
    RuntimeUserName: "nusend-prod-runtime",
    DlqUrl: DLQ_URL,
    DlqArn: DLQ_ARN,
    FeedbackTopicArn: FEEDBACK_TOPIC,
    AlarmTopicArn: ALARM_TOPIC,
    DkimRecordName1: "token1._domainkey.example.com",
    DkimRecordValue1: "token1.dkim.amazonses.com",
    DkimRecordName2: "token2._domainkey.example.com",
    DkimRecordValue2: "token2.dkim.amazonses.com",
    DkimRecordName3: "token3._domainkey.example.com",
    DkimRecordValue3: "token3.dkim.amazonses.com",
  };
}

export type ProviderState = {
  stackExists: boolean;
  stackStatus: string;
  stackLastUpdatedTime: string;
  keyPresent: boolean;
  queueReads: number;
  describeAfterDeleteFailed: boolean;
  remoteOrigin: string;
  remoteHead: string;
  remoteTagSha: string;
  remoteDirty: boolean;
  deleted: boolean;
};

export function providerStateDefaults(): ProviderState {
  return {
    stackExists: true,
    stackStatus: "UPDATE_COMPLETE",
    stackLastUpdatedTime: "2026-01-01T00:00:00.000Z",
    keyPresent: true,
    queueReads: 0,
    describeAfterDeleteFailed: false,
    remoteOrigin: PUBLIC_REPO_URL,
    remoteHead: DEPLOY_SHA,
    remoteTagSha: DEPLOY_SHA,
    remoteDirty: false,
    deleted: false,
  };
}

export type FakeDestroyOptions = {
  calls?: Array<{ argv: string[]; stdin?: string }>;
  providerState?: ProviderState;
  stsAccount?: string;
  accessDeniedOn?: string;
  expiredSessionOn?: string;
  keys?: { AccessKeyId: string; Status: string }[];
  dlqCounters?: { visible: number; notVisible: number; delayed: number };
  sshUnreachable?: boolean;
  failQueueReadNumber?: number;
  failDescribeAfterDeleteOnce?: boolean;
  deleteFails?: boolean;
  resources?: Array<{
    LogicalResourceId: string;
    PhysicalResourceId: string;
    ResourceType: string;
    ResourceStatus: string;
  }>;
  feedbackEndpoint?: string;
  alarmEndpoint?: string;
  alarmState?: string;
  reverseProviderArrays?: boolean;
  stopExitCode?: number;
  stopMessage?: string;
  interruptStopOnce?: boolean;
};

export function fakeDestroyRunCaptured(options: FakeDestroyOptions = {}) {
  const calls = options.calls ?? [];
  const state = options.providerState ?? providerStateDefaults();
  let interruptStop = options.interruptStopOnce === true;
  let failDescribeAfterDelete = options.failDescribeAfterDeleteOnce === true;
  let deleteFails = options.deleteFails === true;
  const defaultResources = [
    {
      LogicalResourceId: "FeedbackTopic",
      PhysicalResourceId: "feedback-topic",
      ResourceType: "AWS::SNS::Topic",
      ResourceStatus: "CREATE_COMPLETE",
    },
    {
      LogicalResourceId: "AlarmTopic",
      PhysicalResourceId: "alarm-topic",
      ResourceType: "AWS::SNS::Topic",
      ResourceStatus: "CREATE_COMPLETE",
    },
  ];

  return (runOptions: RunCapturedOptions): Effect.Effect<ProcessResult, ProcessRunnerError> =>
    Effect.gen(function* () {
      const argv = [runOptions.command, ...(runOptions.args ?? [])];
      calls.push({ argv, stdin: runOptions.stdin });
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

      if (runOptions.command === "git" && runOptions.args?.[0] === "ls-remote") {
        return yield* finish(ok(`${DEPLOY_SHA}\trefs/tags/v0.1.1\n`, 0, "", argv));
      }

      if (runOptions.command === "ssh") {
        if (options.sshUnreachable) {
          return yield* finish(
            ok("", 255, "ssh: connect to host 203.0.113.10 port 22: Connection refused", argv),
          );
        }
        const remote = opensshJoinedRemote(argv);
        if (remote.includes("remote get-url origin")) {
          if (state.remoteDirty) {
            return yield* finish(
              ok(
                [
                  `ORIGIN:${state.remoteOrigin}`,
                  "PORCELAIN: M file",
                  `HEAD:${state.remoteHead}`,
                  "BRANCH:",
                  `TAG_SHA:${state.remoteTagSha}`,
                ].join("\n") + "\n",
                0,
                "",
                argv,
              ),
            );
          }
          return yield* finish(
            ok(
              [
                `ORIGIN:${state.remoteOrigin}`,
                "PORCELAIN:",
                `HEAD:${state.remoteHead}`,
                "BRANCH:",
                `TAG_SHA:${state.remoteTagSha}`,
              ].join("\n") + "\n",
              0,
              "",
              argv,
            ),
          );
        }
        if (remote.includes("docker compose stop")) {
          if (interruptStop) {
            interruptStop = false;
            return yield* finish(ok("", 1, "simulated stop interruption", argv));
          }
          const code = options.stopExitCode ?? 0;
          return yield* finish(
            ok(code === 0 ? "stopped\n" : "", code, options.stopMessage ?? "", argv),
          );
        }
        if (remote.includes("docker compose ps")) {
          return yield* finish(
            ok(
              [
                JSON.stringify({ Service: "api", State: "running", Health: "healthy" }),
                JSON.stringify({ Service: "worker", State: "running", Status: "Up" }),
                JSON.stringify({ Service: "caddy", State: "running", Health: "healthy" }),
                JSON.stringify({ Service: "backup", State: "running", Health: "healthy" }),
              ].join("\n") + "\n",
              0,
              "",
              argv,
            ),
          );
        }
        return yield* finish(ok("", 0, "", argv));
      }

      if (runOptions.command !== "aws") {
        return yield* Effect.die(new Error(`unexpected command ${argv.join(" ")}`));
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
        if (failDescribeAfterDelete && state.deleted) {
          failDescribeAfterDelete = false;
          return yield* finish(ok("", 1, "simulated post-delete interruption"));
        }
        if (!state.stackExists) {
          return yield* finish(ok("", 255, `Stack with id ${STACK_ID} does not exist`));
        }
        return yield* finish(
          ok(
            JSON.stringify({
              Stacks: [
                {
                  StackId: STACK_ID,
                  StackName: "nusend-prod",
                  StackStatus: state.stackStatus,
                  LastUpdatedTime: state.stackLastUpdatedTime,
                  Outputs: Object.entries(stackOutputs()).map(([OutputKey, OutputValue]) => ({
                    OutputKey,
                    OutputValue,
                  })),
                },
              ],
            }),
          ),
        );
      }

      if (args[0] === "cloudformation" && args[1] === "list-stack-resources") {
        if (!state.stackExists) {
          return yield* finish(ok("", 255, "Stack does not exist"));
        }
        let resources = options.resources ?? defaultResources;
        if (options.reverseProviderArrays) resources = [...resources].reverse();
        return yield* finish(ok(JSON.stringify({ StackResourceSummaries: resources })));
      }

      if (args[0] === "cloudformation" && args[1] === "delete-stack") {
        if (deleteFails) {
          deleteFails = false;
          state.stackStatus = "DELETE_FAILED";
          return yield* finish(ok("{}"));
        }
        state.stackExists = false;
        state.deleted = true;
        state.stackStatus = "DELETE_COMPLETE";
        return yield* finish(ok("{}"));
      }

      if (
        args[0] === "cloudformation" &&
        args[1] === "wait" &&
        args[2] === "stack-delete-complete"
      ) {
        if (state.stackStatus === "DELETE_FAILED") {
          return yield* finish(ok("", 255, "Waiter StackDeleteComplete failed"));
        }
        state.stackExists = false;
        return yield* finish(ok(""));
      }

      if (args[0] === "cloudformation" && args[1] === "describe-stack-events") {
        return yield* finish(
          ok(
            JSON.stringify({
              StackEvents: [
                {
                  LogicalResourceId: "WebhookSubscription",
                  ResourceStatus: "DELETE_FAILED",
                  ResourceStatusReason: "endpoint still deleting",
                },
              ],
            }),
          ),
        );
      }

      if (args[0] === "iam" && args[1] === "list-access-keys") {
        if (options.keys) {
          return yield* finish(ok(JSON.stringify({ AccessKeyMetadata: options.keys })));
        }
        return yield* finish(
          ok(
            JSON.stringify({
              AccessKeyMetadata: state.keyPresent
                ? [{ AccessKeyId: KEY_ID, Status: "Active" }]
                : [],
            }),
          ),
        );
      }

      if (args[0] === "iam" && args[1] === "delete-access-key") {
        state.keyPresent = false;
        return yield* finish(ok("{}"));
      }

      if (args[0] === "sqs" && args[1] === "get-queue-attributes") {
        state.queueReads += 1;
        if (options.failQueueReadNumber && state.queueReads === options.failQueueReadNumber) {
          return yield* finish(ok("", 1, "simulated queue interruption"));
        }
        const dlq = options.dlqCounters ?? { visible: 0, notVisible: 0, delayed: 0 };
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

      if (args[0] === "sns" && args[1] === "list-subscriptions-by-topic") {
        const topicIdx = args.indexOf("--topic-arn");
        const topic = String(args[topicIdx + 1] ?? "");
        const isAlarm = topic === ALARM_TOPIC;
        let subscriptions = isAlarm
          ? [
              {
                Protocol: "email",
                Endpoint: options.alarmEndpoint ?? "alerts@example.com",
                SubscriptionArn: `${ALARM_TOPIC}:email-id`,
                Owner: ACCOUNT,
              },
            ]
          : [
              {
                Protocol: "https",
                Endpoint:
                  options.feedbackEndpoint ?? "https://mail.example.com/api/webhooks/aws/sns/ses",
                SubscriptionArn: `${FEEDBACK_TOPIC}:sub-id`,
                Owner: ACCOUNT,
              },
            ];
        if (options.reverseProviderArrays) subscriptions = [...subscriptions].reverse();
        return yield* finish(ok(JSON.stringify({ Subscriptions: subscriptions })));
      }

      if (args[0] === "sns" && args[1] === "get-subscription-attributes") {
        const arnIdx = args.indexOf("--subscription-arn");
        const arn = String(args[arnIdx + 1] ?? "");
        if (arn.includes("email")) {
          return yield* finish(
            ok(
              JSON.stringify({
                Attributes: {
                  Endpoint: options.alarmEndpoint ?? "alerts@example.com",
                  Protocol: "email",
                  PendingConfirmation: "false",
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
                Endpoint:
                  options.feedbackEndpoint ?? "https://mail.example.com/api/webhooks/aws/sns/ses",
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

      if (args[0] === "cloudwatch" && args[1] === "describe-alarms") {
        let alarms = [
          {
            AlarmName: "nusend-prod-sns-notifications-failed",
            StateValue: options.alarmState ?? "OK",
            AlarmActions: [ALARM_TOPIC],
          },
        ];
        if (options.reverseProviderArrays) alarms = [...alarms].reverse();
        return yield* finish(ok(JSON.stringify({ MetricAlarms: alarms })));
      }

      return yield* Effect.die(new Error(`unexpected aws argv: ${argv.join(" ")}`));
    });
}

export function destroyLayer(
  env: NodeJS.ProcessEnv,
  fake: FakeDestroyOptions = {},
  terminalAnswers: readonly string[] = [],
) {
  const calls = fake.calls ?? [];
  fake.calls = calls;
  const terminal = TerminalFake({ answers: terminalAnswers });
  const processLayer = ProcessRunnerFake({
    runCaptured: fakeDestroyRunCaptured(fake),
  });
  const layer = Layer.mergeAll(
    SetupStoreLive,
    terminal.layer,
    processLayer,
    AwsCliLiveWithEnv(env).pipe(Layer.provide(processLayer)),
  ) as Layer.Layer<DestroyWorkflowServices>;
  return { layer, terminal, calls };
}

export async function runDestroyWorkflow<A>(
  effect: Effect.Effect<A, DestroyWorkflowError, DestroyWorkflowServices>,
  layer: Layer.Layer<DestroyWorkflowServices>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

export async function runDestroyWorkflowExit<A>(
  effect: Effect.Effect<A, DestroyWorkflowError, DestroyWorkflowServices>,
  layer: Layer.Layer<DestroyWorkflowServices>,
): Promise<Exit.Exit<A, DestroyWorkflowError>> {
  return Effect.runPromiseExit(effect.pipe(Effect.provide(layer)));
}

export async function seedInstallation(env: NodeJS.ProcessEnv) {
  const now = "2026-01-01T00:00:00.000Z";
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
            marketingEnabled: false,
            trackingEnabled: false,
            alertEmail: "alerts@example.com",
            route53HostedZoneId: null,
            sshTarget: "root@203.0.113.10",
            remotePath: "/srv/nusend",
            installationName: "prod",
          },
          stages: {
            init: { status: "complete", completedAt: now, evidence: { verified: true } },
            aws_core: { status: "complete", completedAt: now, evidence: { verified: true } },
            human_gates: { status: "complete", completedAt: now, evidence: { verified: true } },
            deploy: { status: "complete", completedAt: now, evidence: { verified: true } },
            aws_finalize: { status: "complete", completedAt: now, evidence: { verified: true } },
          },
          plans: {},
          deploy: {
            commitSha: DEPLOY_SHA,
            releaseTag: "v0.1.1",
            sshTarget: "root@203.0.113.10",
            remotePath: "/srv/nusend",
            domain: "mail.example.com",
            appImage: "ghcr.io/maxedapps/nusend:v0.1.1",
            backupImage: "ghcr.io/maxedapps/nusend-backup:v0.1.1",
            appliedAt: now,
            fingerprint: "c".repeat(64),
          },
          aws: {
            runtimeAccessKeyId: KEY_ID,
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
              phase: "finalize",
              status: "UPDATE_COMPLETE",
              outputs: stackOutputs(),
              appliedAt: now,
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
          AWS_ACCESS_KEY_ID: KEY_ID,
          AWS_SECRET_ACCESS_KEY: "runtime-secret-value-xxxxxxxx",
          AWS_SESSION_TOKEN: "temporary-session-value-xxxxxxxx",
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

export function exactKeyIntent() {
  return {
    runtimeAccessKeyId: KEY_ID,
    runtimeUserName: "nusend-prod-runtime",
    stackId: STACK_ID,
    accountId: ACCOUNT,
    region: REGION,
    recordedAt: "2026-01-02T00:00:00.000Z",
  };
}

void RETAINED_RESOURCES;
void PLANNED_SHA;
