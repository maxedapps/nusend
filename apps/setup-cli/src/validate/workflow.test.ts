import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AwsPermissionDeniedError } from "../aws/permissions.ts";
import { SetupStore, SetupStoreLive } from "../services/setup-store.ts";
import type { SetupState } from "../state/schema.ts";
import { ALARM_EXERCISE_PHRASE_PREFIX, CLI_PATH, RUN_SIMULATOR_PHRASE } from "./constants.ts";
import { buildAlarmExercisePhrase, productionGateProgress } from "./pure.ts";
import { runProviderRefresh } from "./refresh.ts";
import {
  runAwsFinalizeStageVerification,
  runFinalValidation,
  runPreSimulatorValidation,
  runSimulatorValidation,
} from "./stages.ts";
import {
  cleanupTemps,
  confirmedSubscription,
  DEPLOY_SHA,
  readinessPayload,
  runValidateWorkflow,
  runValidateWorkflowExit,
  seedFixture,
  testEnv,
  validateLayer,
} from "./test-harness.ts";

afterEach(() => {
  cleanupTemps();
});

async function loadState(env: NodeJS.ProcessEnv, installationId: string): Promise<SetupState> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      return yield* store.loadState(installationId, env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

function failMessage(exit: Exit.Exit<unknown, { message: string }>): string {
  if (Exit.isSuccess(exit)) return "";
  const err = Cause.findErrorOption(exit.cause);
  return Option.isSome(err) ? err.value.message : String(exit.cause);
}

describe("subscription finalization and alarm gates", () => {
  it("requires finalize phase, confirmed subscription, alarms, and exercise phrase", async () => {
    const env = testEnv();
    await seedFixture(env, {
      stages: ["aws_core", "human_gates", "deploy"],
      finalizePhase: false,
    });
    {
      const { layer } = validateLayer(env);
      const exit = await runValidateWorkflowExit(runAwsFinalizeStageVerification(env), layer);
      expect(failMessage(exit)).toMatch(/finalize|aws plan/i);
    }

    await seedFixture(env, {
      stages: ["aws_core", "human_gates", "deploy"],
    });
    {
      const state = await loadState(env, "prod");
      // force finalize phase already set by seed
      expect(state.aws?.stack).toMatchObject({ phase: "finalize" });
      const { layer } = validateLayer(env, {
        feedbackSubscriptions: [
          {
            Protocol: "https",
            Endpoint: "https://wrong.example/hook",
            SubscriptionArn: "arn:sub",
            Owner: "123456789012",
          },
        ],
      });
      const exit = await runValidateWorkflowExit(runAwsFinalizeStageVerification(env), layer);
      expect(failMessage(exit)).toMatch(/endpoint|subscription/i);
    }

    {
      const { layer } = validateLayer(env, { alarmPending: true });
      const exit = await runValidateWorkflowExit(runAwsFinalizeStageVerification(env), layer);
      expect(failMessage(exit)).toMatch(/PendingConfirmation|alarm email/i);
    }

    {
      const state = await loadState(env, "prod");
      const phrase = buildAlarmExercisePhrase(state);
      expect(phrase.startsWith(ALARM_EXERCISE_PHRASE_PREFIX)).toBe(true);
      const { layer, terminal } = validateLayer(env, {}, [phrase]);
      const result = await runValidateWorkflow(runAwsFinalizeStageVerification(env), layer);
      expect(result).toMatchObject({
        verified: true,
        alarmNotificationExercised: true,
      });
      expect(terminal.state.stdout.join("")).toMatch(/dedicated CloudWatch alarm|Exercise/i);
      const after = await loadState(env, "prod");
      expect(after.plans.validation).toMatchObject({
        alarmExercise: { verified: true, alertEmail: "alerts@example.com" },
      });
      expect(JSON.stringify(after.plans.validation)).not.toMatch(/Secret|password/i);
    }
  });

  it("accepts one confirmed exact subscription with raw delivery false and expected DLQ", async () => {
    const env = testEnv();
    await seedFixture(env, {
      stages: ["aws_core", "human_gates", "deploy"],
      alarmExercised: true,
    });
    const { layer } = validateLayer(env, {
      feedbackSubscriptions: [confirmedSubscription()],
    });
    const result = await runValidateWorkflow(runAwsFinalizeStageVerification(env), layer);
    expect(result).toMatchObject({
      verified: true,
      subscription: {
        verified: true,
        endpoint: "https://mail.example.com/api/webhooks/aws/sns/ses",
        rawMessageDelivery: false,
      },
      alarms: { verified: true, alarmCount: 4 },
    });
  });
});

describe("built CLI readiness and final application evidence", () => {
  it("guides build/login for malformed or unauthenticated built CLI responses", async () => {
    const env = testEnv();
    await seedFixture(env, {
      stages: ["aws_core", "human_gates", "deploy", "aws_finalize"],
    });
    {
      const { layer } = validateLayer(env, { readiness: "not-json" });
      const exit = await runValidateWorkflowExit(runPreSimulatorValidation(env), layer);
      expect(failMessage(exit)).toMatch(/malformed JSON/);
    }
    {
      const { layer } = validateLayer(env, {
        readinessExitCode: 3,
        readinessStderr: '{"code":"unauthenticated"}',
      });
      const exit = await runValidateWorkflowExit(runPreSimulatorValidation(env), layer);
      expect(failMessage(exit)).toMatch(/unauthenticated.*login/i);
    }
  });

  it("runs pre-simulator readiness and rejects every nonzero DLQ counter", async () => {
    for (const counters of [
      { visible: 1, notVisible: 0, delayed: 0 },
      { visible: 0, notVisible: 1, delayed: 0 },
      { visible: 0, notVisible: 0, delayed: 1 },
    ]) {
      const env = testEnv();
      await seedFixture(env, {
        stages: ["aws_core", "human_gates", "deploy", "aws_finalize"],
      });
      const { layer } = validateLayer(env, { dlqCounters: counters });
      const exit = await runValidateWorkflowExit(runPreSimulatorValidation(env), layer);
      expect(failMessage(exit)).toMatch(/DLQ is not empty/);
    }

    const env = testEnv();
    await seedFixture(env, {
      stages: ["aws_core", "human_gates", "deploy", "aws_finalize"],
    });
    const { layer, calls } = validateLayer(env, {
      readiness: readinessPayload(false),
    });
    const result = await runValidateWorkflow(runPreSimulatorValidation(env), layer);
    expect(result).toMatchObject({
      verified: true,
      dlq: { visible: 0, notVisible: 0, delayed: 0 },
    });
    expect(calls.some((call) => call.argv[0] === CLI_PATH)).toBe(true);
  });

  it("requires observed feedback and protected global bounce/complaint suppressions", async () => {
    const env = testEnv();
    await seedFixture(env, {
      productionGatesComplete: true,
    });
    {
      const { layer } = validateLayer(env, {
        readiness: readinessPayload(true, false, { feedbackOk: false }),
      });
      const exit = await runValidateWorkflowExit(runFinalValidation(env), layer);
      expect(failMessage(exit)).toMatch(/operations.latest_feedback/);
    }
    {
      const { layer } = validateLayer(env, {
        readiness: readinessPayload(true),
        missingSuppression: "bounce",
      });
      const exit = await runValidateWorkflowExit(runFinalValidation(env), layer);
      expect(failMessage(exit)).toMatch(/protected global bounce suppression/);
    }
  });

  it("runs caller, readiness, suppressions, and DLQ exactly once after all manual gates", async () => {
    const env = testEnv();
    await seedFixture(env, { productionGatesComplete: true });
    const { layer, calls } = validateLayer(env, { readiness: readinessPayload(true) }, ["y"]);
    const result = await runValidateWorkflow(runFinalValidation(env), layer);
    expect(result).toMatchObject({ verified: true });
    expect(calls.filter((call) => call.argv[0] === "aws" && call.argv[1] === "sts")).toHaveLength(
      1,
    );
    expect(
      calls.filter((call) => call.argv[0] === CLI_PATH && call.argv.includes("readiness")),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.argv[0] === CLI_PATH && call.argv.includes("suppressions")),
    ).toHaveLength(2);
    expect(calls.filter((call) => call.argv[0] === "aws" && call.argv[1] === "sqs")).toHaveLength(
      1,
    );
  });
});

describe("remote simulator and production gates", () => {
  it("requires exact confirmation before any SSH call", async () => {
    const env = testEnv();
    await seedFixture(env, {
      stages: ["aws_core", "human_gates", "deploy", "aws_finalize", "validate_pre_simulator"],
    });
    const { layer, calls } = validateLayer(env, {}, ["wrong"]);
    const exit = await runValidateWorkflowExit(runSimulatorValidation(env), layer);
    expect(failMessage(exit)).toMatch(/RUN-SES-SIMULATOR/);
    expect(calls.some((call) => call.argv[0] === "ssh")).toBe(false);
  });

  it("runs success, bounce, complaint sequentially inside the deployed API container and is rerunnable", async () => {
    const env = testEnv();
    await seedFixture(env, {
      stages: ["aws_core", "human_gates", "deploy", "aws_finalize", "validate_pre_simulator"],
    });
    const { layer, calls } = validateLayer(env, {}, [RUN_SIMULATOR_PHRASE, RUN_SIMULATOR_PHRASE]);
    const first = await runValidateWorkflow(runSimulatorValidation(env), layer);
    expect(first).toMatchObject({
      verified: true,
      scenarios: [{ scenario: "success" }, { scenario: "bounce" }, { scenario: "complaint" }],
    });
    const second = await runValidateWorkflow(runSimulatorValidation(env), layer);
    expect(second).toMatchObject({ verified: true });
    const simulatorCalls = calls.filter((call) =>
      call.argv.join(" ").includes("simulator-main.ts"),
    );
    expect(simulatorCalls).toHaveLength(6);
    expect(
      simulatorCalls.every((call) => call.argv.join(" ").includes("docker compose exec -T api")),
    ).toBe(true);
    const state = await loadState(env, "prod");
    expect(state.plans.validation).toMatchObject({
      simulator: {
        verified: true,
        results: [{ scenario: "success" }, { scenario: "bounce" }, { scenario: "complaint" }],
      },
    });
  });

  it("keeps restore/reboot/Gmail/DMARC/quota/firewall as explicit one-at-a-time human gates", async () => {
    const env = testEnv();
    await seedFixture(env, {
      stages: [
        "aws_core",
        "human_gates",
        "deploy",
        "aws_finalize",
        "validate_pre_simulator",
        "validate_simulator",
      ],
      alarmExercised: true,
    });
    const state = await loadState(env, "prod");
    const progress = productionGateProgress(state);
    expect(progress.map((gate) => gate.id)).toEqual([
      "alarm_delivery",
      "backup_restore",
      "reboot_recovery",
      "gmail_headers",
      "dmarc",
      "quota_ramp",
      "provider_firewall",
    ]);
    expect(progress[0]!.complete).toBe(true);
    const first = progress.find((gate) => !gate.complete)!;
    const { layer, calls } = validateLayer(env, {}, [first.phrase]);
    const result = await runValidateWorkflow(runFinalValidation(env), layer);
    expect(result).toMatchObject({ progress: true, completedGate: "backup_restore" });
    expect(calls).toEqual([]);
    const after = await loadState(env, "prod");
    expect(after.plans.validation).toMatchObject({
      productionGates: { backup_restore: { verified: true } },
    });
  });
});

describe("refresh fail-closed and sanitized summaries", () => {
  it("stores redacted refresh summaries, not provider payloads or deployment secrets", async () => {
    const env = testEnv();
    await seedFixture(env);
    // Provider stderr noise must match a secret already present in deployment.env so redaction applies.
    const secret = "runtime-secret-value-xxxxxxxx";
    const { layer } = validateLayer(env, {
      driftFail: true,
      providerNoise: secret,
      readiness: readinessPayload(true),
    });
    const summary = await runValidateWorkflow(runProviderRefresh(env), layer);
    expect(summary).toMatchObject({
      caller: { status: "ok", accountId: "123456789012" },
      stack: { status: "ok", stackStatus: "UPDATE_COMPLETE" },
      subscription: { status: "ok", confirmed: true },
      dlq: { status: "ok", visible: 0, notVisible: 0, delayed: 0 },
      remote: { status: "ok", composeHealthy: true },
      readiness: { status: "ok" },
    });
    expect(summary.drift).toMatchObject({ status: "unavailable" });
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(JSON.stringify(summary)).toContain("***");
    expect(JSON.stringify(summary)).not.toContain("SecretAccessKey");
    expect(JSON.stringify(summary)).not.toContain("runtime-secret-value");
    const state = await loadState(env, "prod");
    expect(state.plans.refresh).toEqual(summary);
  });

  it("blocks refresh after caller binding failure without stack, drift, remote, or CLI access", async () => {
    const env = testEnv();
    await seedFixture(env);
    const { layer, calls } = validateLayer(env, { stsAccount: "999999999999" });
    const summary = await runValidateWorkflow(runProviderRefresh(env), layer);
    // SSO gate may issue configure get/list before STS; no provider mutations afterward.
    expect(calls.every((call) => call.argv[0] === "aws")).toBe(true);
    expect(
      calls.some((call) => call.argv[1] === "sts" && call.argv[2] === "get-caller-identity"),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.argv[1] === "cloudformation" || call.argv[0] === "ssh" || call.argv[0] === CLI_PATH,
      ),
    ).toBe(false);
    expect(summary).toMatchObject({
      caller: { status: "unavailable" },
      blocked: { status: "blocked", reason: "aws-caller-binding" },
    });
    expect(summary).not.toHaveProperty("stack");
    expect(summary).not.toHaveProperty("drift");
    expect(summary).not.toHaveProperty("remote");
  });

  it("emits AccessDenied handoff at remote-independent AWS boundary without SSH", async () => {
    const env = testEnv();
    await seedFixture(env, {
      stages: ["aws_core", "human_gates", "deploy"],
      alarmExercised: true,
    });
    const { layer, terminal, calls } = validateLayer(env, {
      accessDeniedOn: "list-subscriptions-by-topic",
    });
    const exit = await runValidateWorkflowExit(runAwsFinalizeStageVerification(env), layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(err) && err.value instanceof AwsPermissionDeniedError).toBe(true);
    }
    expect(terminal.state.stdout.join("")).toMatch(/permission handoff/i);
    expect(calls.some((call) => call.argv[0] === "ssh")).toBe(false);
  });

  it("fails closed on auth expiry at STS without SSH or remote mutation", async () => {
    const env = testEnv();
    await seedFixture(env, {
      stages: ["aws_core", "human_gates", "deploy", "aws_finalize"],
    });
    const { layer, calls } = validateLayer(env, { expiredSessionOn: "get-caller-identity" }, ["n"]);
    const exit = await runValidateWorkflowExit(runPreSimulatorValidation(env), layer);
    expect(failMessage(exit)).toMatch(
      /expired|token|sso|login declined|authentication incomplete/i,
    );
    expect(calls.some((call) => call.argv[0] === "ssh" || call.argv[0] === CLI_PATH)).toBe(false);
    expect(calls.every((call) => call.argv[0] === "aws")).toBe(true);
  });
});

void DEPLOY_SHA;
