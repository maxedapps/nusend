import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Layer } from "effect";

import { AwsCliLiveWithEnv } from "../auth/aws-cli.ts";
import { ProcessFailedError } from "../errors.ts";
import {
  ProcessRunnerFake,
  type ProcessResult,
  type ProcessRunnerError,
  type RunCapturedOptions,
} from "../process-runner.ts";
import { SetupStoreLive } from "../services/setup-store.ts";
import { TerminalFake } from "../terminal.ts";
import { REQUIRED_CAPABILITY } from "./constants.ts";
import type { AwsWorkflowError, AwsWorkflowServices } from "./ops.ts";

export const temporaryDirectories: string[] = [];

export function testEnv(): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-cli-aws-"));
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

export function ok(stdout: string, exitCode = 0, stderr = ""): ProcessResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
    argv: [],
  };
}

export function stackIdFor(stackName: string): string {
  return `arn:aws:cloudformation:us-east-1:123456789012:stack/${stackName}/00000000-0000-0000-0000-000000000001`;
}

export function sampleOutputs(): Record<string, string> {
  return {
    AwsRegion: "us-east-1",
    SesFromEmail: "sender@example.com",
    TransactionalConfigurationSetName: "nusend-prod-transactional",
    MarketingConfigurationSetName: "",
    FeedbackTopicArn: "arn:aws:sns:us-east-1:123456789012:nusend-prod-ses-events",
    TrackingEvents: "",
    RuntimeUserName: "nusend-prod-runtime",
    DlqUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/dlq",
    DlqArn: "arn:aws:sqs:us-east-1:123456789012:dlq",
    DlqName: "nusend-prod-ses-webhook-dlq",
    AlarmTopicArn: "arn:aws:sns:us-east-1:123456789012:alarms",
    DkimRecordName1: "token1._domainkey.example.com",
    DkimRecordValue1: "token1.dkim.amazonses.com",
    DkimRecordName2: "token2._domainkey.example.com",
    DkimRecordValue2: "token2.dkim.amazonses.com",
    DkimRecordName3: "token3._domainkey.example.com",
    DkimRecordValue3: "token3.dkim.amazonses.com",
  };
}

export function readyIdentity() {
  return {
    VerificationStatus: "SUCCESS",
    VerifiedForSendingStatus: true,
    DkimAttributes: {
      Status: "SUCCESS",
      SigningEnabled: true,
    },
  };
}

export function pendingIdentity() {
  return {
    VerificationStatus: "PENDING",
    VerifiedForSendingStatus: false,
    DkimAttributes: {
      Status: "PENDING",
      SigningEnabled: true,
    },
  };
}

export function validBrief() {
  return {
    website: "https://shop.northwindtraders.com",
    useCase: "Transactional order receipts and password resets for paying customers.",
    mailType: "TRANSACTIONAL",
    expectedVolume: "about 20_000 messages per month",
    frequency: "continuous low-volume transactional bursts",
    recipientConsent: "Collected at checkout with explicit order-notification consent.",
    unsubscribe: "One-click List-Unsubscribe plus account preference center.",
    bounceComplaintHandling: "SNS webhook into Nusend suppressions within minutes.",
    formAbuseControls: "Authenticated API only; no public unauthenticated send forms.",
    monitoring: "CloudWatch alarms plus daily complaint rate review.",
    contactLanguage: "EN",
  };
}

export function createChangeSetDescription(input: {
  changeSetArn: string;
  status: string;
  changes: unknown[];
  statusReason?: string;
  executionStatus?: string;
  stackId?: string;
  stackName?: string;
}) {
  return {
    Status: input.status,
    StatusReason: input.statusReason ?? "",
    ExecutionStatus: input.executionStatus ?? "AVAILABLE",
    ChangeSetId: input.changeSetArn,
    ChangeSetName: "nusend-prod-core",
    StackId: input.stackId ?? stackIdFor("nusend-prod"),
    StackName: input.stackName ?? "nusend-prod",
    Capabilities: [REQUIRED_CAPABILITY],
    Changes: input.changes,
  };
}

export function assertAwsProfileRegion(args: readonly string[]) {
  const profileIdx = args.indexOf("--profile");
  const regionIdx = args.indexOf("--region");
  if (profileIdx < 0 || regionIdx < 0) {
    throw new Error(`missing profile/region in ${args.join(" ")}`);
  }
  if (args[profileIdx + 1] !== "nusend-provisioner") {
    throw new Error(`unexpected profile ${args[profileIdx + 1]}`);
  }
  if (args[regionIdx + 1] !== "us-east-1") {
    throw new Error(`unexpected region ${args[regionIdx + 1]}`);
  }
}

/** Shared modern SSO configure responses for fake ProcessRunner AWS CLIs. */
export function fakeConfigureResponse(args: readonly string[]): ProcessResult | null {
  if (args[0] !== "configure") return null;
  if (args[1] === "list-profiles") {
    return ok("nusend-provisioner\n");
  }
  if (args[1] === "list") {
    return ok(
      "      Name                    Value             Type    Location\n      ----                    -----             ----    --------\n   profile                nusend-provisioner              config\naccess_key     ********************              sso\n",
    );
  }
  if (args[1] === "get") {
    const key = args[2] ?? "";
    const profileIdx = args.indexOf("--profile");
    const profile = profileIdx >= 0 ? args[profileIdx + 1] : null;
    if (key.startsWith("sso-session.")) {
      if (key.endsWith(".sso_region")) return ok("us-east-1\n");
      return ok("", 1, "not found");
    }
    if (profile && profile !== "nusend-provisioner") return ok("", 1, "not found");
    const values: Record<string, string> = {
      sso_session: "nusend-provisioner-sso",
      sso_account_id: "123456789012",
      sso_role_name: "NusendProvisioner",
      region: "us-east-1",
    };
    if (values[key] != null) return ok(`${values[key]}\n`);
    return ok("", 1, "not found");
  }
  return null;
}

export function sampleAwsAuth() {
  return {
    type: "sso" as const,
    profileName: "nusend-provisioner",
    ssoSessionName: "nusend-provisioner-sso",
    accountId: "123456789012",
    roleName: "NusendProvisioner",
    identityCenterRegion: "us-east-1",
    partition: "aws",
    verifiedAccountId: "123456789012",
    verifiedAt: "2026-01-01T00:00:00.000Z",
    boundAt: "2026-01-01T00:00:00.000Z",
  };
}

export type FakeAwsOptions = {
  calls?: string[][];
  stackExists?: boolean;
  stackStatus?: string;
  stackId?: string;
  stackOutputs?: Record<string, string>;
  changeSetArn?: string;
  changeSet?: Record<string, unknown>;
  changeSetFactory?: () => Record<string, unknown>;
  waitChangeSetExitCode?: number;
  waitStackExitCode?: number;
  executeExitCode?: number;
  executeStderr?: string;
  stackEvents?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  account?: Record<string, unknown>;
  accessKeys?: unknown[];
  createdAccessKey?: { AccessKeyId: string; SecretAccessKey: string };
  feedbackSubscriptions?: Record<string, unknown>[];
  /** Override STS account for mismatch tests. */
  stsAccount?: string;
  /** Force AccessDenied on a matching service action substring. */
  accessDeniedOn?: string;
};

export function fakeAwsRunCaptured(options: FakeAwsOptions) {
  const calls = options.calls ?? [];
  return (runOptions: RunCapturedOptions): Effect.Effect<ProcessResult, ProcessRunnerError> =>
    Effect.gen(function* () {
      const args = [...(runOptions.args ?? [])];
      const argv = [runOptions.command, ...args];
      calls.push(argv);
      if (runOptions.command !== "aws") {
        return yield* Effect.die(new Error(`unexpected command ${runOptions.command}`));
      }

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

      const configure = fakeConfigureResponse(args);
      if (configure) return yield* finish(configure);

      assertAwsProfileRegion(args);

      if (options.accessDeniedOn && args.join(" ").includes(options.accessDeniedOn)) {
        return yield* finish(
          ok("", 255, "An error occurred (AccessDenied) when calling the operation"),
        );
      }

      if (args[0] === "sts" && args[1] === "get-caller-identity") {
        const account = options.stsAccount ?? "123456789012";
        return yield* finish(
          ok(
            JSON.stringify({
              Account: account,
              Arn: `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_NusendProvisioner_ab12cd/user`,
            }),
          ),
        );
      }

      if (args[0] === "cloudformation" && args[1] === "validate-template") {
        return yield* finish(ok(JSON.stringify({ Parameters: [], Description: "ok" })));
      }

      if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
        if (!options.stackExists) {
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
                  StackId: options.stackId ?? stackIdFor("nusend-prod"),
                  StackName: "nusend-prod",
                  StackStatus: options.stackStatus ?? "CREATE_COMPLETE",
                  Outputs: outputs,
                },
              ],
            }),
          ),
        );
      }

      if (args[0] === "cloudformation" && args[1] === "delete-change-set") {
        return yield* finish(ok("{}", 0));
      }

      if (args[0] === "cloudformation" && args[1] === "create-change-set") {
        if (!args.includes(REQUIRED_CAPABILITY)) {
          return yield* Effect.die(new Error("missing capability"));
        }
        return yield* finish(
          ok(JSON.stringify({ Id: options.changeSetArn, StackId: stackIdFor("nusend-prod") })),
        );
      }

      if (
        args[0] === "cloudformation" &&
        args[1] === "wait" &&
        args[2] === "change-set-create-complete"
      ) {
        return yield* finish(ok("", options.waitChangeSetExitCode ?? 0));
      }

      if (args[0] === "cloudformation" && args[1] === "describe-change-set") {
        const requestedArnIdx = args.indexOf("--change-set-name");
        const requestedArn = requestedArnIdx >= 0 ? String(args[requestedArnIdx + 1] ?? "") : "";
        if (options.changeSetFactory) {
          return yield* finish(ok(JSON.stringify(options.changeSetFactory())));
        }
        if (options.changeSet) {
          return yield* finish(ok(JSON.stringify(options.changeSet)));
        }
        return yield* finish(
          ok(
            JSON.stringify(
              createChangeSetDescription({
                changeSetArn:
                  options.changeSetArn ||
                  requestedArn ||
                  "arn:aws:cloudformation:us-east-1:123456789012:changeSet/x/y",
                status: "CREATE_COMPLETE",
                changes: [],
              }),
            ),
          ),
        );
      }

      if (args[0] === "cloudformation" && args[1] === "execute-change-set") {
        return yield* finish(ok("{}", options.executeExitCode ?? 0, options.executeStderr ?? ""));
      }

      if (
        args[0] === "cloudformation" &&
        args[1] === "wait" &&
        (args[2] === "stack-create-complete" || args[2] === "stack-update-complete")
      ) {
        return yield* finish(ok("", options.waitStackExitCode ?? 0));
      }

      if (args[0] === "cloudformation" && args[1] === "describe-stack-events") {
        return yield* finish(ok(JSON.stringify(options.stackEvents ?? { StackEvents: [] })));
      }

      if (args[0] === "sns" && args[1] === "list-subscriptions-by-topic") {
        return yield* finish(
          ok(JSON.stringify({ Subscriptions: options.feedbackSubscriptions ?? [] })),
        );
      }

      if (args[0] === "sns" && args[1] === "get-subscription-attributes") {
        return yield* finish(
          ok(
            JSON.stringify({
              Attributes: {
                Endpoint: "https://mail.example.com/api/webhooks/aws/sns/ses",
                Protocol: "https",
                PendingConfirmation: "false",
                RawMessageDelivery: "false",
                RedrivePolicy: JSON.stringify({
                  deadLetterTargetArn: sampleOutputs().DlqArn,
                }),
              },
            }),
          ),
        );
      }

      if (args[0] === "sesv2" && args[1] === "get-email-identity") {
        return yield* finish(ok(JSON.stringify(options.identity ?? readyIdentity())));
      }

      if (args[0] === "sesv2" && args[1] === "get-account") {
        return yield* finish(
          ok(
            JSON.stringify(
              options.account ?? {
                ProductionAccessEnabled: false,
                Details: { ReviewDetails: { Status: "NONE" } },
              },
            ),
          ),
        );
      }

      if (args[0] === "sesv2" && args[1] === "put-account-details") {
        return yield* finish(ok("{}"));
      }

      if (args[0] === "iam" && args[1] === "list-access-keys") {
        return yield* finish(ok(JSON.stringify({ AccessKeyMetadata: options.accessKeys ?? [] })));
      }

      if (args[0] === "iam" && args[1] === "create-access-key") {
        const key = options.createdAccessKey ?? {
          AccessKeyId: "AKIADEFAULT00000000",
          SecretAccessKey: "default-secret",
        };
        return yield* finish(ok(JSON.stringify({ AccessKey: key })));
      }

      return yield* Effect.die(new Error(`unexpected aws argv: ${argv.join(" ")}`));
    });
}

export function workflowLayer(
  env: NodeJS.ProcessEnv,
  fake: FakeAwsOptions,
  terminalAnswers: readonly string[] = [],
): {
  layer: Layer.Layer<AwsWorkflowServices>;
  terminal: ReturnType<typeof TerminalFake>;
  calls: string[][];
} {
  const calls = fake.calls ?? [];
  fake.calls = calls;
  const terminal = TerminalFake({ answers: terminalAnswers });
  const layer = Layer.mergeAll(
    SetupStoreLive,
    terminal.layer,
    AwsCliLiveWithEnv(env).pipe(
      Layer.provide(
        ProcessRunnerFake({
          runCaptured: fakeAwsRunCaptured(fake),
        }),
      ),
    ),
  );
  return { layer, terminal, calls };
}

export async function runWorkflow<A>(
  effect: Effect.Effect<A, AwsWorkflowError, AwsWorkflowServices>,
  layer: Layer.Layer<AwsWorkflowServices>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

export async function runWorkflowExit<A>(
  effect: Effect.Effect<A, AwsWorkflowError, AwsWorkflowServices>,
  layer: Layer.Layer<AwsWorkflowServices>,
): Promise<Exit.Exit<A, AwsWorkflowError>> {
  return Effect.runPromiseExit(effect.pipe(Effect.provide(layer)));
}

export function sampleState(installationId: string) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 2 as const,
    installationId,
    createdAt: now,
    updatedAt: now,
    config: {
      releaseTag: "v0.1.1",
      domain: "mail.example.com",
      ingressMode: "direct" as const,
      ownerEmail: "owner@example.com",
      ownerName: "Owner",
      awsProfile: "nusend-provisioner",
      awsRegion: "us-east-1",
      awsAccountId: "123456789012",
      sesIdentity: "example.com",
      sesFromEmail: "sender@example.com",
      marketingEnabled: false,
      trackingEnabled: false,
      alertEmail: "alerts@example.com",
      route53HostedZoneId: null,
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      installationName: installationId,
    },
    stages: {
      init: {
        status: "complete" as const,
        completedAt: now,
        evidence: { verified: true, installationId },
      },
    },
    plans: {},
    awsAuth: sampleAwsAuth(),
  };
}

export function validApplyPlan(overrides: Record<string, unknown> = {}) {
  return {
    changeSetArn: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/apply",
    changeSetName: "nusend-prod-core",
    stackName: "nusend-prod",
    stackId: stackIdFor("nusend-prod"),
    phase: "core",
    changeSetType: "CREATE",
    accountId: "123456789012",
    partition: "aws",
    region: "us-east-1",
    noChange: false,
    ...overrides,
  };
}
