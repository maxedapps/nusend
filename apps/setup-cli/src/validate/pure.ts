import type { SetupState } from "../state/schema.ts";
import {
  ALARM_EXERCISE_PHRASE_PREFIX,
  BASE_REQUIRED_READINESS_IDS,
  MARKETING_REQUIRED_READINESS_IDS,
  PRODUCTION_GATE_DEFINITIONS,
  VALIDATION_PLAN_KEY,
} from "./constants.ts";

export function buildAlarmExercisePhrase(state: SetupState): string {
  return `${ALARM_EXERCISE_PHRASE_PREFIX} ${state.config.alertEmail}`;
}

export function requiredReadinessIds(state: SetupState, final = false): string[] {
  return [
    ...BASE_REQUIRED_READINESS_IDS,
    ...(state.config.marketingEnabled ? MARKETING_REQUIRED_READINESS_IDS : []),
    ...(final ? ["operations.latest_feedback"] : []),
  ];
}

export function assertReadinessPayload(
  payload: unknown,
  requiredIds: readonly string[],
): {
  status: string;
  requiredIds: string[];
  checkCount: number;
} {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Nusend CLI readiness JSON must be an object.");
  }
  const checks = (payload as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) throw new Error("Nusend CLI readiness JSON is missing checks[].");
  const byId = new Map<string, { id: string; status: string }>();
  for (const check of checks) {
    if (check && typeof check === "object" && typeof (check as { id?: unknown }).id === "string") {
      const id = (check as { id: string }).id;
      if (byId.has(id)) throw new Error(`Nusend readiness returned duplicate check id ${id}.`);
      byId.set(id, check as { id: string; status: string });
    }
  }
  const missing = requiredIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`Nusend readiness is missing required checks: ${missing.join(", ")}.`);
  }
  const failing = requiredIds
    .map((id) => byId.get(id)!)
    .filter((check) => check.status !== "ok")
    .map((check) => `${check.id}=${check.status}`);
  if (failing.length > 0) {
    throw new Error(`Required Nusend readiness checks are not ok: ${failing.join(", ")}.`);
  }
  return {
    status: String((payload as { status?: unknown }).status ?? ""),
    requiredIds: [...requiredIds],
    checkCount: checks.length,
  };
}

export function parseSimulatorResult(
  stdout: string,
  scenario: string,
): {
  scenario: string;
  status: string;
  runId: string;
  recipientEmail: string;
} {
  const lines = String(stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      if (payload && typeof payload === "object" && typeof payload.status === "string") {
        if (payload.status !== "validated") {
          throw new Error(
            `Simulator ${scenario} ended with status ${payload.status}, expected validated.`,
          );
        }
        const runId = String(payload.runId ?? "");
        const recipientEmail = String(payload.recipientEmail ?? "");
        const expectedRecipient = `${scenario}@simulator.amazonses.com`;
        if (!runId || recipientEmail !== expectedRecipient) {
          throw new Error(
            `Simulator ${scenario} returned incomplete/wrong evidence (runId=${runId || "missing"}, recipient=${recipientEmail || "missing"}).`,
          );
        }
        return { scenario, status: payload.status, runId, recipientEmail };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Simulator ")) throw error;
    }
  }
  throw new Error(`Simulator ${scenario} returned no valid JSON result.`);
}

export function assertProtectedSuppression(
  payload: unknown,
  reason: string,
  email: string,
): { email: string; scope: "all"; reason: string } {
  if (
    payload == null ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { items?: unknown }).items)
  ) {
    throw new Error(`Suppression JSON for ${reason} is malformed.`);
  }
  const found = (payload as { items: Array<Record<string, unknown>> }).items.some(
    (item) => item?.email === email && item?.scope === "all" && item?.reason === reason,
  );
  if (!found) {
    throw new Error(`Expected protected global ${reason} suppression for ${email} was not found.`);
  }
  return { email, scope: "all", reason };
}

export function assertSimulatorStageEvidence(evidence: unknown): true {
  const scenarios =
    evidence && typeof evidence === "object"
      ? (evidence as { scenarios?: unknown }).scenarios
      : undefined;
  if (!Array.isArray(scenarios)) {
    throw new Error("Final validation requires stored simulator scenario evidence.");
  }
  for (const expected of ["success", "bounce", "complaint"]) {
    const matches = scenarios.filter(
      (scenario) =>
        scenario &&
        typeof scenario === "object" &&
        (scenario as { scenario?: unknown }).scenario === expected &&
        (scenario as { status?: unknown }).status === "validated" &&
        typeof (scenario as { runId?: unknown }).runId === "string" &&
        String((scenario as { runId: string }).runId).length > 0 &&
        (scenario as { recipientEmail?: unknown }).recipientEmail ===
          `${expected}@simulator.amazonses.com`,
    );
    if (matches.length !== 1) {
      throw new Error(`Final validation requires one validated ${expected} simulator result.`);
    }
  }
  return true;
}

export function productionGateEvidence(state: SetupState): Record<string, unknown> {
  const validation = state.plans?.[VALIDATION_PLAN_KEY];
  return validation &&
    typeof validation === "object" &&
    typeof validation.productionGates === "object" &&
    validation.productionGates
    ? (validation.productionGates as Record<string, unknown>)
    : {};
}

export type ProductionGateProgressItem = {
  readonly id: string;
  readonly title: string;
  readonly action: string;
  readonly phrase: string;
  readonly complete: boolean;
};

export function productionGateProgress(state: SetupState): ProductionGateProgressItem[] {
  const evidence = productionGateEvidence(state);
  const alarmExercise = state.plans?.[VALIDATION_PLAN_KEY]?.alarmExercise;
  return [
    {
      id: "alarm_delivery",
      title: "Alarm notification delivery exercise",
      action: "Exercise and observe the dedicated alarm notification.",
      phrase: buildAlarmExercisePhrase(state),
      complete: Boolean(alarmExercise),
    },
    ...PRODUCTION_GATE_DEFINITIONS.map((gate) => ({
      id: gate.id,
      title: gate.title,
      action: gate.action,
      phrase: gate.phrase(state as never),
      complete: evidence[gate.id] != null,
    })),
  ];
}

export function parseCounter(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`SQS ${name} is invalid.`);
  return number;
}

export function assertDlqEmpty(counters: {
  visible: number;
  notVisible: number;
  delayed: number;
}): typeof counters {
  const nonzero = Object.entries(counters).filter(([, value]) => value !== 0);
  if (nonzero.length > 0) {
    throw new Error(
      `DLQ is not empty: ${nonzero.map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    );
  }
  return counters;
}
