import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runAwsPlan } from "./aws.mjs";
import { createContext, runContinue, runSetup } from "./main.mjs";
import {
  ALARM_EXERCISE_PHRASE_PREFIX,
  BASE_REQUIRED_READINESS_IDS,
  CLI_PATH,
  MARKETING_REQUIRED_READINESS_IDS,
  RUN_SIMULATOR_PHRASE,
  assertDlqEmpty,
  assertPreFinalizeSubscriptionAbsence,
  assertProtectedSuppression,
  assertReadinessPayload,
  assertSimulatorStageEvidence,
  buildAlarmExercisePhrase,
  parseSimulatorResult,
  parseSubscriptionAttributes,
  parseSubscriptions,
  productionGateProgress,
  requiredReadinessIds,
  runAwsFinalizeStageVerification,
  runFinalValidation,
  runPreSimulatorValidation,
  runProviderRefresh,
  runReadinessValidation,
  runSimulatorValidation,
  verifyAlarmsAndEmail,
  verifyFinalizedSubscription,
} from "./validate.mjs";
import { loadState, writeCurrentPointer, writeDeploymentEnv, writeState } from "./state.mjs";

const temporaryDirectories: string[] = [];
const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const STACK_ID = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/nusend-prod/stack-id`;
const FEEDBACK_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:nusend-prod-ses-events`;
const ALARM_TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:nusend-prod-ops-alarms`;
const DLQ_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:nusend-prod-ses-webhook-dlq`;
const DLQ_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/nusend-prod-ses-webhook-dlq`;
const SUBSCRIPTION_ARN = `${FEEDBACK_TOPIC}:subscription-id`;
const ALARM_SUBSCRIPTION_ARN = `${ALARM_TOPIC}:email-id`;
const TEST_CLI_PATH = process.execPath;

const ALL_STAGES = [
  "aws_core",
  "human_gates",
  "deploy",
  "aws_finalize",
  "validate_pre_simulator",
  "validate_simulator",
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("subscription finalization guards", () => {
  it("parses subscription payloads and rejects malformed attributes", () => {
    expect(
      parseSubscriptions({
        Subscriptions: [
          {
            SubscriptionArn: "PendingConfirmation",
            Protocol: "HTTPS",
            Endpoint: "https://mail.example.com/hook",
          },
        ],
      }),
    ).toEqual([
      {
        subscriptionArn: "PendingConfirmation",
        protocol: "https",
        endpoint: "https://mail.example.com/hook",
        owner: "",
      },
    ]);
    expect(
      parseSubscriptionAttributes({
        Attributes: {
          Endpoint: "https://mail.example.com/hook",
          Protocol: "https",
          PendingConfirmation: "false",
          RawMessageDelivery: "false",
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: DLQ_ARN }),
        },
      }),
    ).toMatchObject({ pending: false, rawMessageDelivery: "false", redriveArn: DLQ_ARN });
    expect(() => parseSubscriptionAttributes({ Attributes: { RedrivePolicy: "{" } })).toThrow(
      /malformed JSON/,
    );
  });

  it.each([
    [
      "pending",
      [
        {
          Protocol: "https",
          Endpoint: "https://mail.example.com/hook",
          SubscriptionArn: "PendingConfirmation",
        },
      ],
    ],
    [
      "confirmed",
      [
        {
          Protocol: "https",
          Endpoint: "https://wrong.example/hook",
          SubscriptionArn: SUBSCRIPTION_ARN,
        },
      ],
    ],
    [
      "duplicate",
      [
        {
          Protocol: "https",
          Endpoint: "https://mail.example.com/hook",
          SubscriptionArn: SUBSCRIPTION_ARN,
        },
        {
          Protocol: "https",
          Endpoint: "https://wrong.example/hook",
          SubscriptionArn: `${SUBSCRIPTION_ARN}-2`,
        },
      ],
    ],
  ])(
    "blocks finalize planning when a %s HTTPS subscription exists",
    async (_label, subscriptions) => {
      const fixture = await seedFixture({ stages: ["aws_core", "human_gates", "deploy"] });
      const executor = fakeExecutor({ feedbackSubscriptions: subscriptions });
      await expect(
        assertPreFinalizeSubscriptionAbsence(fixture.ctx(executor), fixture.state),
      ).rejects.toThrow(/pre-existing HTTPS|pending|duplicate|wrong endpoint/i);
    },
  );

  it("requires healthy deploy evidence and exact topic allowlisting before the absence precheck", async () => {
    const noDeploy = await seedFixture({ stages: ["aws_core", "human_gates"] });
    await expect(
      assertPreFinalizeSubscriptionAbsence(noDeploy.ctx(fakeExecutor()), noDeploy.state),
    ).rejects.toThrow(/healthy deploy stage/);

    const mismatch = await seedFixture({
      stages: ["aws_core", "human_gates", "deploy"],
      feedbackEnv: "arn:wrong",
    });
    await expect(
      assertPreFinalizeSubscriptionAbsence(mismatch.ctx(fakeExecutor()), mismatch.state),
    ).rejects.toThrow(/topic allowlist/);
  });

  it("reads every SNS page before deciding subscription absence", async () => {
    const fixture = await seedFixture({ stages: ["aws_core", "human_gates", "deploy"] });
    await expect(
      assertPreFinalizeSubscriptionAbsence(
        fixture.ctx(
          fakeExecutor({
            feedbackPages: [
              { Subscriptions: [], NextToken: "page-2" },
              { Subscriptions: [confirmedSubscription()] },
            ],
          }),
        ),
        fixture.state,
      ),
    ).rejects.toThrow(/pre-existing HTTPS/);
  });

  it("allows finalize planning precheck only with zero HTTPS subscriptions", async () => {
    const fixture = await seedFixture({ stages: ["aws_core", "human_gates", "deploy"] });
    await expect(
      assertPreFinalizeSubscriptionAbsence(
        fixture.ctx(
          fakeExecutor({
            feedbackSubscriptions: [
              { Protocol: "email", Endpoint: "other@example.com", SubscriptionArn: "arn:email" },
            ],
          }),
        ),
        fixture.state,
      ),
    ).resolves.toMatchObject({ verified: true, httpsCount: 0, topicArn: FEEDBACK_TOPIC });
  });

  it.each([
    [
      "pending",
      [
        {
          Protocol: "https",
          Endpoint: expectedEndpoint(),
          SubscriptionArn: "PendingConfirmation",
          Owner: ACCOUNT,
        },
      ],
      {},
      /PendingConfirmation/,
    ],
    [
      "duplicate",
      [
        confirmedSubscription(),
        { ...confirmedSubscription(), SubscriptionArn: `${SUBSCRIPTION_ARN}-2` },
      ],
      {},
      /found 2|duplicates/,
    ],
    [
      "wrong endpoint",
      [{ ...confirmedSubscription(), Endpoint: "https://wrong.example/hook" }],
      {},
      /endpoint/,
    ],
    [
      "raw delivery",
      [confirmedSubscription()],
      { rawMessageDelivery: "true" },
      /wrong endpoint.*raw-delivery|raw-delivery/i,
    ],
    ["redrive", [confirmedSubscription()], { redriveArn: "arn:wrong" }, /redrive/i],
  ])(
    "rejects finalized subscription with %s state",
    async (_label, subscriptions, attributes, pattern) => {
      const fixture = await seedFixture({ stages: ALL_STAGES });
      await expect(
        verifyFinalizedSubscription(
          fixture.ctx(fakeExecutor({ feedbackSubscriptions: subscriptions, ...attributes })),
          fixture.state,
          { attempts: 1 },
        ),
      ).rejects.toThrow(pattern);
    },
  );

  it("accepts one confirmed exact subscription with raw delivery false and the expected DLQ", async () => {
    const fixture = await seedFixture({ stages: ALL_STAGES });
    await expect(
      verifyFinalizedSubscription(fixture.ctx(fakeExecutor()), fixture.state, { attempts: 1 }),
    ).resolves.toMatchObject({
      verified: true,
      endpoint: expectedEndpoint(),
      rawMessageDelivery: false,
      dlqArn: DLQ_ARN,
    });
  });

  it("runs the absence guard before creating a finalize change set", async () => {
    const fixture = await seedFixture({ stages: ["aws_core", "human_gates", "deploy"] });
    const calls: string[][] = [];
    await expect(
      runAwsPlan(
        fixture.ctx(fakeExecutor({ calls, feedbackSubscriptions: [confirmedSubscription()] })),
      ),
    ).rejects.toThrow(/pre-existing HTTPS/);
    expect(calls.some((call) => call.includes("create-change-set"))).toBe(false);
  });
});

describe("alarm confirmation and exercise evidence", () => {
  it("blocks while the exact stack-owned alarm email subscription is pending", async () => {
    const fixture = await seedFixture({ stages: ["aws_core", "human_gates", "deploy"] });
    await expect(
      verifyAlarmsAndEmail(
        fixture.ctx(
          fakeExecutor({
            alarmSubscriptions: [
              { ...alarmSubscription(), SubscriptionArn: "PendingConfirmation" },
            ],
          }),
        ),
        fixture.state,
      ),
    ).rejects.toThrow(/PendingConfirmation.*confirmation email/i);
  });

  it("rejects feedback-topic alarm actions and accepts four dedicated alarm actions", async () => {
    const fixture = await seedFixture({ stages: ["aws_core", "human_gates", "deploy"] });
    await expect(
      verifyAlarmsAndEmail(
        fixture.ctx(fakeExecutor({ alarmAction: FEEDBACK_TOPIC })),
        fixture.state,
      ),
    ).rejects.toThrow(/dedicated alarm topic/);
    await expect(
      verifyAlarmsAndEmail(fixture.ctx(fakeExecutor()), fixture.state),
    ).resolves.toMatchObject({ verified: true, alarmCount: 4, alarmTopicArn: ALARM_TOPIC });
  });

  it("requires exact exercised-notification evidence and persists only nonsecret evidence", async () => {
    const fixture = await seedFixture({ stages: ["aws_core", "human_gates", "deploy"] });
    const phrase = buildAlarmExercisePhrase(fixture.state);
    expect(phrase).toBe(`${ALARM_EXERCISE_PHRASE_PREFIX} alerts@example.com`);
    await expect(
      runAwsFinalizeStageVerification(
        fixture.ctx(fakeExecutor(), { answers: ["wrong"] }),
        fixture.state,
      ),
    ).rejects.toThrow(/Evidence rejected/);

    await expect(
      runAwsFinalizeStageVerification(
        fixture.ctx(fakeExecutor(), { answers: [phrase] }),
        fixture.state,
      ),
    ).resolves.toMatchObject({ verified: true, alarmNotificationExercised: true });
    const state = await loadState("prod", fixture.env);
    expect(state.plans.validation.alarmExercise).toMatchObject({
      verified: true,
      alertEmail: "alerts@example.com",
    });
  });
});

describe("built CLI readiness and final application evidence", () => {
  it("keeps the production CLI default while allowing a hermetic injected executable", async () => {
    expect(createContext().cliPath).toBe(CLI_PATH);
    const fixture = await seedFixture({ stages: ALL_STAGES });
    const calls: string[][] = [];
    await runReadinessValidation(fixture.ctx(fakeExecutor({ calls })), fixture.state, false);
    expect(calls[0]?.[0]).toBe(TEST_CLI_PATH);
  });

  it("selects transactional and configured marketing readiness IDs", async () => {
    const plain = await seedFixture({ stages: ALL_STAGES });
    expect(requiredReadinessIds(plain.state)).toEqual(BASE_REQUIRED_READINESS_IDS);
    const marketing = await seedFixture({ stages: ALL_STAGES, marketingEnabled: true });
    expect(requiredReadinessIds(marketing.state)).toEqual([
      ...BASE_REQUIRED_READINESS_IDS,
      ...MARKETING_REQUIRED_READINESS_IDS,
    ]);
    expect(requiredReadinessIds(marketing.state, true)).toContain("operations.latest_feedback");
  });

  it("rejects missing, duplicate, and non-ok required readiness checks", () => {
    const payload = readinessPayload(false, false);
    expect(assertReadinessPayload(payload, BASE_REQUIRED_READINESS_IDS)).toMatchObject({
      requiredIds: BASE_REQUIRED_READINESS_IDS,
    });
    expect(() => assertReadinessPayload({ checks: [] }, ["config.aws_region"])).toThrow(/missing/);
    expect(() =>
      assertReadinessPayload(
        {
          checks: [
            { id: "x", status: "ok" },
            { id: "x", status: "ok" },
          ],
        },
        ["x"],
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      assertReadinessPayload({ checks: [{ id: "x", status: "warning" }] }, ["x"]),
    ).toThrow(/not ok/);
  });

  it("guides build/login for malformed or unauthenticated built CLI responses", async () => {
    const fixture = await seedFixture({ stages: ALL_STAGES });
    await expect(
      runReadinessValidation(
        fixture.ctx(fakeExecutor({ cliStdout: "not-json" })),
        fixture.state,
        false,
      ),
    ).rejects.toThrow(/malformed JSON/);
    await expect(
      runReadinessValidation(
        fixture.ctx(fakeExecutor({ cliExitCode: 3, cliStderr: '{"code":"unauthenticated"}' })),
        fixture.state,
        false,
      ),
    ).rejects.toThrow(/unauthenticated.*login/i);
  });

  it("runs pre-simulator readiness and rejects every nonzero DLQ counter", async () => {
    await Promise.all(
      [
        { visible: 1, notVisible: 0, delayed: 0 },
        { visible: 0, notVisible: 1, delayed: 0 },
        { visible: 0, notVisible: 0, delayed: 1 },
      ].map(async (counters) => {
        const fixture = await seedFixture({
          stages: ["aws_core", "human_gates", "deploy", "aws_finalize"],
        });
        await expect(
          runPreSimulatorValidation(fixture.ctx(fakeExecutor({ dlqCounters: counters }))),
        ).rejects.toThrow(/DLQ is not empty/);
      }),
    );
    expect(() => assertDlqEmpty({ visible: 0, notVisible: 0, delayed: 0 })).not.toThrow();
  });

  it("requires observed feedback and protected global bounce/complaint suppressions", async () => {
    const fixture = await seedFixture({ stages: ALL_STAGES, productionGatesComplete: true });
    await expect(
      runFinalValidation(fixture.ctx(fakeExecutor({ readinessFeedbackOk: false }))),
    ).rejects.toThrow(/operations.latest_feedback=warning/);
    await expect(
      runFinalValidation(fixture.ctx(fakeExecutor({ missingSuppression: "bounce" }))),
    ).rejects.toThrow(/protected global bounce suppression/);
    expect(() =>
      assertProtectedSuppression({ items: [] }, "complaint", "complaint@simulator.amazonses.com"),
    ).toThrow(/complaint suppression/);
  });

  it("runs caller, readiness, suppressions, and DLQ exactly once after all manual gates", async () => {
    const fixture = await seedFixture({ stages: ALL_STAGES, productionGatesComplete: true });
    const calls: string[][] = [];
    await expect(runFinalValidation(fixture.ctx(fakeExecutor({ calls })))).resolves.toMatchObject({
      verified: true,
    });

    expect(calls.filter((call) => call[0] === "aws" && call[1] === "sts")).toHaveLength(1);
    expect(calls.filter((call) => call.join(" ").includes("ses readiness"))).toHaveLength(1);
    expect(calls.filter((call) => call.join(" ").includes("suppressions list"))).toHaveLength(2);
    expect(calls.filter((call) => call[0] === "aws" && call[1] === "sqs")).toHaveLength(1);
  });
});

describe("remote simulator and production gates", () => {
  it("requires exact confirmation before any SSH call", async () => {
    const fixture = await seedFixture({
      stages: ["aws_core", "human_gates", "deploy", "aws_finalize", "validate_pre_simulator"],
    });
    const calls: string[][] = [];
    await expect(
      runSimulatorValidation(fixture.ctx(fakeExecutor({ calls }), { answers: ["wrong"] })),
    ).rejects.toThrow(/RUN-SES-SIMULATOR/);
    expect(calls.some((call) => call[0] === "ssh")).toBe(false);
  });

  it("runs success, bounce, complaint sequentially inside the deployed API container and is rerunnable", async () => {
    const fixture = await seedFixture({
      stages: ["aws_core", "human_gates", "deploy", "aws_finalize", "validate_pre_simulator"],
    });
    const calls: string[][] = [];
    const ctx = fixture.ctx(fakeExecutor({ calls }), {
      answers: [RUN_SIMULATOR_PHRASE, RUN_SIMULATOR_PHRASE],
    });
    await expect(runSimulatorValidation(ctx)).resolves.toMatchObject({
      verified: true,
      scenarios: [{ scenario: "success" }, { scenario: "bounce" }, { scenario: "complaint" }],
    });
    await expect(runSimulatorValidation(ctx)).resolves.toMatchObject({ verified: true });
    const simulatorCalls = calls.filter((call) => call.join(" ").includes("simulator-main.ts"));
    expect(simulatorCalls.map((call) => scenarioFromCall(call.join(" ")))).toEqual([
      "success",
      "bounce",
      "complaint",
      "success",
      "bounce",
      "complaint",
    ]);
    expect(
      simulatorCalls.every((call) => call.join(" ").includes("docker compose exec -T api")),
    ).toBe(true);
  });

  it("rejects simulator non-validated, malformed, and incomplete stored evidence", () => {
    expect(() => parseSimulatorResult('{"status":"timed_out"}', "bounce")).toThrow(/timed_out/);
    expect(() => parseSimulatorResult("not-json", "bounce")).toThrow(/no valid JSON/);
    expect(() =>
      assertSimulatorStageEvidence({
        scenarios: [
          {
            scenario: "success",
            status: "validated",
            runId: "run-success",
            recipientEmail: "success@simulator.amazonses.com",
          },
        ],
      }),
    ).toThrow(/validated bounce/);
  });

  it("keeps restore/reboot/Gmail/DMARC/quota/firewall as explicit one-at-a-time human gates", async () => {
    const fixture = await seedFixture({ stages: ALL_STAGES, alarmExercised: true });
    const progress = productionGateProgress(fixture.state);
    expect(progress.map((gate) => gate.id)).toEqual([
      "alarm_delivery",
      "backup_restore",
      "reboot_recovery",
      "gmail_headers",
      "dmarc",
      "quota_ramp",
      "provider_firewall",
    ]);
    expect(progress[0].complete).toBe(true);
    const first = progress.find((gate) => !gate.complete)!;
    const calls: string[][] = [];
    const result = await runFinalValidation(
      fixture.ctx(fakeExecutor({ calls }), { answers: [first.phrase] }),
    );
    expect(result).toMatchObject({ progress: true, completedGate: "backup_restore" });
    expect(calls).toEqual([]);
    const state = await loadState("prod", fixture.env);
    expect(state.plans.validation.productionGates.backup_restore).toMatchObject({ verified: true });
    expect(state.plans.validation.finalAutomated).toBeUndefined();
  });
});

describe("refresh and main-stage integration", () => {
  it("stores redacted refresh summaries, not provider payloads or deployment secrets", async () => {
    const fixture = await seedFixture({ stages: ALL_STAGES });
    const secret = "top-secret-deployment-value";
    const summary = await runProviderRefresh(
      fixture.ctx(fakeExecutor({ providerNoise: secret })),
      fixture.state,
    );
    expect(summary).toMatchObject({
      caller: { status: "ok", accountId: ACCOUNT },
      stack: { status: "ok", stackStatus: "UPDATE_COMPLETE" },
      subscription: { status: "ok", confirmed: true },
      dlq: { status: "ok", visible: 0, notVisible: 0, delayed: 0 },
      remote: { status: "ok", composeHealthy: true },
      readiness: { status: "ok" },
    });
    const state = await loadState("prod", fixture.env);
    expect(state.plans.refresh.drift).toMatchObject({ status: "unavailable", message: "***" });
    expect(JSON.stringify(state.plans.refresh)).not.toContain(secret);
    expect(JSON.stringify(state.plans.refresh)).not.toContain("SecretAccessKey");
  });

  it("blocks refresh after caller binding failure without stack, drift, remote, or CLI access", async () => {
    const fixture = await seedFixture({ stages: ALL_STAGES });
    const calls: string[][] = [];
    const summary = await runProviderRefresh(
      fixture.ctx(fakeExecutor({ calls, callerAccount: "999999999999" })),
      fixture.state,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["aws", "sts", "get-caller-identity"]);
    expect(summary).toMatchObject({
      caller: { status: "unavailable" },
      blocked: { status: "blocked", reason: "aws-caller-binding" },
    });
    expect(summary).not.toHaveProperty("stack");
    expect(summary).not.toHaveProperty("drift");
    const state = await loadState("prod", fixture.env);
    expect(state.plans.refresh).toEqual(summary);
  });

  it("preserves simulator evidence persisted by the real handler when continue checkpoints", async () => {
    const fixture = await seedFixture({
      stages: ["aws_core", "human_gates", "deploy", "aws_finalize", "validate_pre_simulator"],
    });
    const calls: string[][] = [];
    await runContinue(fixture.ctx(fakeExecutor({ calls }), { answers: [RUN_SIMULATOR_PHRASE] }));

    const state = await loadState("prod", fixture.env);
    expect(state.stages.validate_simulator?.evidence).toMatchObject({
      verified: true,
      scenarios: [{ scenario: "success" }, { scenario: "bounce" }, { scenario: "complaint" }],
    });
    expect(state.plans.validation.simulator).toMatchObject({
      verified: true,
      results: [{ scenario: "success" }, { scenario: "bounce" }, { scenario: "complaint" }],
    });
  });

  it("wires validate commands and all T6 continue stages while preserving one stage per continue", async () => {
    const fixture = await seedFixture({
      stages: ["aws_core", "human_gates", "deploy"],
      alarmExercised: true,
    });
    const calls: string[] = [];
    await runContinue({
      ...fixture.ctx(fakeExecutor()),
      stageHandlers: {
        aws_finalize: {
          run: async () => {
            calls.push("aws_finalize");
            return { verified: true };
          },
        },
        validate_pre_simulator: {
          run: async () => {
            calls.push("pre");
            return { verified: true };
          },
        },
      },
    });
    expect(calls).toEqual(["aws_finalize"]);
    expect((await loadState("prod", fixture.env)).stages.validate_pre_simulator).toBeUndefined();

    const direct = await seedFixture({
      stages: ["aws_core", "human_gates", "deploy", "aws_finalize"],
    });
    const result = await runSetup(["validate", "pre-simulator"], {
      ...direct.ctx(fakeExecutor()),
    });
    expect(result.exitCode).toBe(0);
  });
});

function expectedEndpoint() {
  return "https://mail.example.com/api/webhooks/aws/sns/ses";
}

function confirmedSubscription() {
  return {
    Protocol: "https",
    Endpoint: expectedEndpoint(),
    SubscriptionArn: SUBSCRIPTION_ARN,
    Owner: ACCOUNT,
  };
}

function alarmSubscription() {
  return {
    Protocol: "email",
    Endpoint: "alerts@example.com",
    SubscriptionArn: ALARM_SUBSCRIPTION_ARN,
    Owner: ACCOUNT,
  };
}

function readinessPayload(marketing: boolean, feedbackOk = true) {
  const ids = [
    ...BASE_REQUIRED_READINESS_IDS,
    ...(marketing ? MARKETING_REQUIRED_READINESS_IDS : []),
    "operations.latest_feedback",
  ];
  return {
    status: "ok",
    checkedAt: "2026-01-02T00:00:00.000Z",
    expectedWebhookUrl: expectedEndpoint(),
    checks: ids.map((id) => ({
      id,
      status: id === "operations.latest_feedback" && !feedbackOk ? "warning" : "ok",
      title: id,
      message: "ok",
      action: null,
      docs: [],
    })),
  };
}

function simulatorJson(scenario: string) {
  const email = `${scenario}@simulator.amazonses.com`;
  return JSON.stringify({
    status: "validated",
    runId: `run-${scenario}`,
    recipientEmail: email,
    deliveryId: `delivery-${scenario}`,
    mailingId: `mailing-${scenario}`,
  });
}

function scenarioFromCall(joined: string) {
  for (const scenario of ["success", "bounce", "complaint"]) {
    if (joined.includes(`simulator-main.ts ${scenario}`)) return scenario;
  }
  return "unknown";
}

function expectedAlarms(action: string) {
  return [
    ["sns-notifications-failed", "NumberOfNotificationsFailed"],
    ["sns-redriven-to-dlq", "NumberOfNotificationsRedrivenToDlq"],
    ["sns-redrive-failed", "NumberOfNotificationsFailedToRedriveToDlq"],
    ["dlq-visible-messages", "ApproximateNumberOfMessagesVisible"],
  ].map(([suffix, metric]) => ({
    AlarmName: `nusend-prod-${suffix}`,
    MetricName: metric,
    AlarmActions: [action],
    StateValue: "OK",
  }));
}

function fakeExecutor(
  options: {
    calls?: string[][];
    feedbackSubscriptions?: Record<string, unknown>[];
    feedbackPages?: Record<string, unknown>[];
    alarmSubscriptions?: Record<string, unknown>[];
    rawMessageDelivery?: string;
    redriveArn?: string;
    alarmAction?: string;
    cliStdout?: string;
    cliExitCode?: number;
    cliStderr?: string;
    readinessFeedbackOk?: boolean;
    missingSuppression?: "bounce" | "complaint";
    dlqCounters?: { visible: number; notVisible: number; delayed: number };
    providerNoise?: string;
    callerAccount?: string;
  } = {},
) {
  const calls = options.calls ?? [];
  let feedbackPage = 0;
  return async ({ command, args }: { command: string; args: readonly string[] }) => {
    const argv = [command, ...args];
    calls.push(argv);
    const joined = argv.join(" ");

    if (command === TEST_CLI_PATH) {
      if (options.cliExitCode)
        return ok(options.cliStdout ?? "", options.cliExitCode, options.cliStderr ?? "");
      if (joined.includes("ses readiness")) {
        return ok(
          options.cliStdout ??
            JSON.stringify(readinessPayload(false, options.readinessFeedbackOk ?? true)),
        );
      }
      if (joined.includes("suppressions list")) {
        const reason = joined.includes("--reason bounce") ? "bounce" : "complaint";
        const email = `${reason}@simulator.amazonses.com`;
        const items =
          options.missingSuppression === reason
            ? []
            : [
                {
                  id: `suppression-${reason}`,
                  email,
                  scope: "all",
                  reason,
                  listId: null,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              ];
        return ok(
          JSON.stringify({ items, pagination: { limit: 50, offset: 0, nextOffset: null } }),
        );
      }
    }

    if (command === "curl") return ok(joined.includes("/health/db") ? "404" : "200");

    if (command === "ssh") {
      if (joined.includes("simulator-main.ts")) return ok(simulatorJson(scenarioFromCall(joined)));
      if (joined.includes("docker compose ps --format json")) {
        return ok(
          JSON.stringify(
            ["api", "worker", "caddy", "backup"].map((Service) => ({
              Service,
              State: "running",
              Status: Service === "api" || Service === "backup" ? "running (healthy)" : "running",
            })),
          ),
        );
      }
      if (joined.includes("health/db")) return ok("");
      return ok("healthy\n");
    }

    if (command !== "aws") throw new Error(`unexpected command: ${joined}`);
    if (args[0] === "sts")
      return ok(
        JSON.stringify({
          Account: options.callerAccount ?? ACCOUNT,
          Arn: `arn:aws:iam::${options.callerAccount ?? ACCOUNT}:user/provisioner`,
          Noise: options.providerNoise,
        }),
      );
    if (args[0] === "sns" && args[1] === "list-subscriptions-by-topic") {
      const topicIndex = args.indexOf("--topic-arn");
      const topic = args[topicIndex + 1];
      if (topic === ALARM_TOPIC) {
        return ok(
          JSON.stringify({
            Subscriptions: options.alarmSubscriptions ?? [alarmSubscription()],
          }),
        );
      }
      if (options.feedbackPages) {
        const page = options.feedbackPages[feedbackPage] ?? { Subscriptions: [] };
        feedbackPage += 1;
        return ok(JSON.stringify(page));
      }
      return ok(
        JSON.stringify({
          Subscriptions: options.feedbackSubscriptions ?? [confirmedSubscription()],
        }),
      );
    }
    if (args[0] === "sns" && args[1] === "get-subscription-attributes") {
      return ok(
        JSON.stringify({
          Attributes: {
            Endpoint: expectedEndpoint(),
            Protocol: "https",
            PendingConfirmation: "false",
            RawMessageDelivery: options.rawMessageDelivery ?? "false",
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: options.redriveArn ?? DLQ_ARN }),
          },
        }),
      );
    }
    if (args[0] === "cloudwatch")
      return ok(
        JSON.stringify({ MetricAlarms: expectedAlarms(options.alarmAction ?? ALARM_TOPIC) }),
      );
    if (args[0] === "sqs") {
      const counters = options.dlqCounters ?? { visible: 0, notVisible: 0, delayed: 0 };
      return ok(
        JSON.stringify({
          Attributes: {
            ApproximateNumberOfMessages: String(counters.visible),
            ApproximateNumberOfMessagesNotVisible: String(counters.notVisible),
            ApproximateNumberOfMessagesDelayed: String(counters.delayed),
          },
        }),
      );
    }
    if (args[0] === "cloudformation" && args[1] === "describe-stacks")
      return ok(
        JSON.stringify({
          Stacks: [
            {
              StackId: STACK_ID,
              StackName: "nusend-prod",
              StackStatus: "UPDATE_COMPLETE",
              Outputs: Object.entries(outputs()).map(([OutputKey, OutputValue]) => ({
                OutputKey,
                OutputValue,
              })),
            },
          ],
        }),
      );
    if (args[0] === "cloudformation" && args[1] === "detect-stack-drift") {
      if (options.providerNoise) throw new Error(options.providerNoise);
      return ok(JSON.stringify({ StackDriftDetectionId: "drift-detection-id" }));
    }
    if (
      args[0] === "cloudformation" &&
      args[1] === "wait" &&
      args[2] === "stack-drift-detection-complete"
    ) {
      return ok("");
    }
    if (args[0] === "cloudformation" && args[1] === "describe-stack-drift-detection-status") {
      return ok(
        JSON.stringify({
          DetectionStatus: "DETECTION_COMPLETE",
          StackDriftStatus: "IN_SYNC",
        }),
      );
    }
    if (args[0] === "cloudformation" && args[1] === "describe-stack-resource-drifts") {
      return ok(
        JSON.stringify({
          StackResourceDrifts: [
            { LogicalResourceId: "FeedbackTopic", StackResourceDriftStatus: "IN_SYNC" },
          ],
        }),
      );
    }
    if (args[0] === "cloudformation" && args[1] === "validate-template") return ok("{}");
    if (args[0] === "sesv2" && args[1] === "get-email-identity")
      return ok(
        JSON.stringify({
          VerificationStatus: "SUCCESS",
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: "SUCCESS", SigningEnabled: true },
        }),
      );
    if (args[0] === "sesv2" && args[1] === "get-account")
      return ok(
        JSON.stringify({
          ProductionAccessEnabled: true,
          SendingEnabled: true,
          Details: { ReviewDetails: { Status: "GRANTED" } },
        }),
      );
    throw new Error(`unexpected aws command: ${joined}`);
  };
}

async function seedFixture(
  options: {
    stages?: string[];
    marketingEnabled?: boolean;
    feedbackEnv?: string;
    alarmExercised?: boolean;
    productionGatesComplete?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "nusend-validate-"));
  temporaryDirectories.push(directory);
  const env = { NUSEND_SETUP_HOME: directory, HOME: directory };
  const now = "2026-01-01T00:00:00.000Z";
  const stages: Record<string, any> = {
    init: { status: "complete", completedAt: now, evidence: { verified: true } },
  };
  for (const id of options.stages ?? []) {
    stages[id] = {
      status: "complete",
      completedAt: now,
      evidence:
        id === "validate_simulator"
          ? {
              verified: true,
              scenarios: ["success", "bounce", "complaint"].map((scenario) => ({
                scenario,
                status: "validated",
                runId: `run-${scenario}`,
                recipientEmail: `${scenario}@simulator.amazonses.com`,
              })),
            }
          : { verified: true },
    };
  }
  const plans: Record<string, any> = {};
  if (options.alarmExercised || options.productionGatesComplete) {
    plans.validation = { alarmExercise: { verified: true, completedAt: now } };
  }
  if (options.productionGatesComplete) {
    plans.validation.productionGates = Object.fromEntries(
      [
        "backup_restore",
        "reboot_recovery",
        "gmail_headers",
        "dmarc",
        "quota_ramp",
        "provider_firewall",
      ].map((id) => [id, { verified: true, completedAt: now }]),
    );
  }
  const state = {
    schemaVersion: 1 as const,
    installationId: "prod",
    createdAt: now,
    updatedAt: now,
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
      marketingEnabled: options.marketingEnabled ?? false,
      trackingEnabled: false,
      alertEmail: "alerts@example.com",
      route53HostedZoneId: null,
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
    },
    stages,
    plans,
    aws: {
      runtimeAccessKeyId: "AKIARUNTIME000000000",
      stack: {
        stackId: STACK_ID,
        stackName: "nusend-prod",
        accountId: ACCOUNT,
        partition: "aws",
        region: REGION,
        phase: "finalize",
        status: "UPDATE_COMPLETE",
        outputs: outputs(),
      },
      productionAccess: {
        status: "approved",
        productionAccessEnabled: true,
        reviewStatus: "GRANTED",
      },
      identity: {
        verificationStatus: "SUCCESS",
        verifiedForSending: true,
        dkimStatus: "SUCCESS",
        dkimSigningEnabled: true,
      },
    },
    deploy: { commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", releaseTag: "v0.1.1" },
  };
  await writeState(state, env);
  await writeDeploymentEnv(
    "prod",
    {
      NUSEND_DOMAIN: "mail.example.com",
      NUSEND_INGRESS_MODE: "direct",
      NUSEND_OWNER_EMAIL: "owner@example.com",
      NUSEND_OWNER_NAME: "Owner",
      BETTER_AUTH_SECRET: "top-secret-deployment-value",
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "google-secret-value",
      NUSEND_API_KEY_HASH_SECRET: "hash-secret-value",
      NUSEND_UNSUBSCRIBE_SECRET: "unsubscribe-secret-value",
      AWS_ACCESS_KEY_ID: "AKIARUNTIME000000000",
      AWS_SECRET_ACCESS_KEY: "aws-secret-value",
      AWS_REGION: REGION,
      NUSEND_SES_FROM_EMAIL: "sender@example.com",
      NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "nusend-prod-transactional",
      NUSEND_SES_FEEDBACK_TOPIC_ARNS: options.feedbackEnv ?? FEEDBACK_TOPIC,
      NUSEND_RESTIC_REPOSITORY: "s3:https://example.invalid/bucket/nusend",
      NUSEND_R2_ACCESS_KEY_ID: "r2-access",
      NUSEND_R2_SECRET_ACCESS_KEY: "r2-secret-value",
      NUSEND_RESTIC_PASSWORD: "restic-secret-value",
    },
    env,
  );
  await writeCurrentPointer("prod", env);
  const loaded = await loadState("prod", env);
  return {
    env,
    state: loaded,
    ctx(
      executor: ReturnType<typeof fakeExecutor>,
      ioOptions: { answers?: string[]; logs?: string[] } = {},
    ) {
      const answers = ioOptions.answers ?? [];
      const logs = ioOptions.logs ?? [];
      return {
        env,
        executor,
        cliPath: TEST_CLI_PATH,
        sleep: async () => undefined,
        io: {
          prompt: async () => answers.shift() ?? "",
          promptSecret: async () => "",
          log: (line: string) => logs.push(line),
          error: (line: string) => logs.push(line),
        },
      };
    },
  };
}

function outputs() {
  return {
    AwsRegion: REGION,
    SesFromEmail: "sender@example.com",
    TransactionalConfigurationSetName: "nusend-prod-transactional",
    MarketingConfigurationSetName: "",
    FeedbackTopicArn: FEEDBACK_TOPIC,
    RuntimeUserName: "nusend-prod-runtime",
    DlqUrl: DLQ_URL,
    DlqArn: DLQ_ARN,
    DlqName: "nusend-prod-ses-webhook-dlq",
    AlarmTopicArn: ALARM_TOPIC,
  };
}

function ok(stdout: string, exitCode = 0, stderr = "") {
  return { exitCode, signal: null, stdout, stderr, argv: [] };
}
