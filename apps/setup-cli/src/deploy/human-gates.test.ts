import { Cause, Effect, Exit, Layer, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ProcessRunnerFake } from "../process-runner.ts";
import { SetupStoreError } from "../errors.ts";
import { SetupStore, SetupStoreFake, SetupStoreLive } from "../services/setup-store.ts";
import { TerminalFake } from "../terminal.ts";
import type { SetupState } from "../state/schema.ts";
import { HUMAN_GATE_DEFINITIONS, listHumanGateProgress, runHumanGatesStep } from "./human-gates.ts";
import { cleanupTemps, seedInstallation, testEnv } from "./test-harness.ts";

afterEach(() => {
  cleanupTemps();
});

function failMessage(exit: Exit.Exit<unknown, { message: string }>): string {
  if (Exit.isSuccess(exit)) return "";
  const err = Cause.findErrorOption(exit.cause);
  return Option.isSome(err) ? err.value.message : String(exit.cause);
}

async function loadState(env: NodeJS.ProcessEnv, installationId: string): Promise<SetupState> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      return yield* store.loadState(installationId, env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

function gatesLayer(terminalAnswers: readonly string[] = []) {
  const terminal = TerminalFake({ answers: terminalAnswers });
  const layer = Layer.mergeAll(SetupStoreLive, terminal.layer, ProcessRunnerFake({}));
  return { layer, terminal };
}

describe("human gates", () => {
  it("defines named Google/DNS/R2/restic/alarm/SES gates with phrases", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true });
    const state = await loadState(env, "prod");
    expect(HUMAN_GATE_DEFINITIONS.map((gate) => gate.id)).toEqual([
      "google_oauth",
      "dns_firewall",
      "r2_bucket",
      "restic_escrow",
      "alarm_email",
      "ses_approval",
    ]);
    expect(HUMAN_GATE_DEFINITIONS[0]!.confirmationPhrase(state)).toBe(
      "GOOGLE-OAUTH mail.example.com",
    );
    expect(listHumanGateProgress(state).every((gate) => !gate.complete)).toBe(true);
  });

  it("continue records one human-gate evidence action and does not complete the stage early", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true });
    const state = await loadState(env, "prod");
    const phrase = HUMAN_GATE_DEFINITIONS[0]!.confirmationPhrase(state);
    const { layer, terminal } = gatesLayer([phrase]);
    const result = await Effect.runPromise(runHumanGatesStep(env).pipe(Effect.provide(layer)));
    expect(result).toMatchObject({
      verified: false,
      progress: true,
      completedGate: "google_oauth",
    });
    expect(terminal.state.stdout.join("")).toMatch(/Google OAuth/i);
    const after = await loadState(env, "prod");
    expect(after.stages.human_gates?.status).not.toBe("complete");
    expect(after.plans.human_gates).toMatchObject({
      completed: { google_oauth: expect.objectContaining({ phrase }) },
    });
  });

  it("still presents its gates when deployment.env cannot be read", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true });
    const state = await loadState(env, "prod");
    const phrase = HUMAN_GATE_DEFINITIONS[0]!.confirmationPhrase(state);
    const terminal = TerminalFake({ answers: [phrase] });
    const layer = Layer.mergeAll(
      SetupStoreFake({
        loadDeploymentEnv: () =>
          Effect.fail(new SetupStoreError({ message: "env unreadable", reason: "io" })),
      }),
      terminal.layer,
      ProcessRunnerFake({}),
    );

    const result = await Effect.runPromise(runHumanGatesStep(env).pipe(Effect.provide(layer)));

    expect(result).toMatchObject({ completedGate: "google_oauth", progress: true });
    expect(terminal.state.stdout.join("")).toMatch(/Google OAuth/i);
  });

  it("rejects mismatched human-gate evidence phrases", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true });
    const { layer } = gatesLayer(["WRONG-PHRASE"]);
    const exit = await Effect.runPromiseExit(runHumanGatesStep(env).pipe(Effect.provide(layer)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failMessage(exit)).toMatch(/Evidence rejected|google_oauth/i);
  });

  it("auto-satisfies SES approval from nonsecret AWS evidence and finishes remaining gates", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", {
      awsCoreComplete: true,
      productionAccessEnabled: true,
    });

    const phrases = [
      "GOOGLE-OAUTH mail.example.com",
      "DNS-FIREWALL mail.example.com direct 80,443",
      "R2-PRIVATE prod",
      "RESTIC-ESCROW prod",
      "ALARM-EMAIL alerts@example.com",
    ];
    const { layer } = gatesLayer(phrases);
    let remaining = phrases.length;
    while (remaining > 0) {
      const result = await Effect.runPromise(runHumanGatesStep(env).pipe(Effect.provide(layer)));
      if (result.verified) break;
      remaining -= 1;
    }
    const final = await Effect.runPromise(runHumanGatesStep(env).pipe(Effect.provide(layer)));
    expect(final).toMatchObject({ verified: true });
    const state = await loadState(env, "prod");
    const progress = listHumanGateProgress(state);
    expect(progress.every((gate) => gate.complete)).toBe(true);
    expect(
      progress.find((gate) => gate.id === "ses_approval")?.autoSatisfied ||
        progress.find((gate) => gate.id === "ses_approval")?.complete,
    ).toBe(true);
  });
});
