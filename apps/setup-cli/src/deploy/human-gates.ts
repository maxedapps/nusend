import { Clock, Effect } from "effect";

import { ask, writeLine } from "../commands/prompts.ts";
import { CancellationError, SetupCommandError, SetupStoreError, TerminalError } from "../errors.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import { plainDeploymentEnv } from "../state/env.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import type { TerminalService } from "../terminal.ts";
import { DEPLOY_PLAN_KEY } from "./constants.ts";

export type HumanGateDefinition = {
  readonly id: string;
  readonly title: string;
  readonly requiredValues: (state: SetupState) => Record<string, string | boolean>;
  readonly buildPrompt: (state: SetupState, deploymentEnv?: Record<string, string>) => string;
  readonly confirmationPhrase: (state: SetupState) => string;
  readonly isAlreadySatisfied?: (state: SetupState) => boolean;
};

export const HUMAN_GATE_DEFINITIONS: readonly HumanGateDefinition[] = Object.freeze([
  Object.freeze({
    id: "google_oauth",
    title: "Google OAuth exact origin and redirect",
    requiredValues(state: SetupState) {
      const origin = `https://${state.config.domain}`;
      return {
        authorizedJavaScriptOrigin: origin,
        authorizedRedirectUri: `${origin}/api/auth/callback/google`,
      };
    },
    buildPrompt(state: SetupState) {
      const values = this.requiredValues(state);
      return [
        "Create a Google OAuth Web application client with these exact values:",
        `  Authorized JavaScript origin: ${values.authorizedJavaScriptOrigin}`,
        `  Authorized redirect URI:      ${values.authorizedRedirectUri}`,
        "Confirm the client already uses both values (the coordinator cannot open Google Console).",
      ].join("\n");
    },
    confirmationPhrase(state: SetupState) {
      return `GOOGLE-OAUTH ${state.config.domain}`;
    },
  }),
  Object.freeze({
    id: "dns_firewall",
    title: "External DNS and firewall ports/mode",
    requiredValues(state: SetupState) {
      return {
        domain: state.config.domain,
        ingressMode: state.config.ingressMode,
        ports: "80,443",
        note:
          state.config.ingressMode === "cloudflare"
            ? "Proxied Cloudflare DNS + Full (strict); origin 80/443 only from Cloudflare ranges"
            : "Public A/AAAA to host; inbound TCP 80/443 open",
      };
    },
    buildPrompt(state: SetupState) {
      const values = this.requiredValues(state);
      return [
        "Configure external DNS and the provider firewall (the coordinator will not mutate them):",
        `  Domain: ${values.domain}`,
        `  Ingress mode: ${values.ingressMode}`,
        `  Required ports: TCP ${values.ports}`,
        `  Expectation: ${values.note}`,
      ].join("\n");
    },
    confirmationPhrase(state: SetupState) {
      return `DNS-FIREWALL ${state.config.domain} ${state.config.ingressMode} 80,443`;
    },
  }),
  Object.freeze({
    id: "r2_bucket",
    title: "R2 private bucket, token, and repository",
    requiredValues(_state: SetupState) {
      return {
        bucketVisibility: "private-bucket",
        objectAccessScope: "Object Read & Write for the selected bucket only",
        repositoryForm: "s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>/nusend",
      };
    },
    buildPrompt(_state: SetupState, deploymentEnv: Record<string, string> = {}) {
      const repository =
        deploymentEnv.NUSEND_RESTIC_REPOSITORY?.trim() || "(set in deployment.env)";
      return [
        "Confirm the Cloudflare R2 backup target (coordinator cannot create R2 resources):",
        "  Bucket: private",
        "  Token: Object Read & Write, apply to that bucket only",
        `  Repository in deployment.env: ${repository}`,
        "  Form: s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>/nusend",
      ].join("\n");
    },
    confirmationPhrase(state: SetupState) {
      return `R2-PRIVATE ${state.installationId}`;
    },
  }),
  Object.freeze({
    id: "restic_escrow",
    title: "Independently escrowed restic password",
    requiredValues(_state: SetupState) {
      return {
        escrow: "off-server password manager or equivalent independent store",
        warning: "Losing the restic password makes every backup unreadable",
      };
    },
    buildPrompt(_state: SetupState) {
      return [
        "Escrow the generated NUSEND_RESTIC_PASSWORD independently off-server.",
        "The coordinator will not print or recover it. Losing it makes R2 backups unrecoverable.",
        "Confirm the password is stored outside this workstation setup home.",
      ].join("\n");
    },
    confirmationPhrase(state: SetupState) {
      return `RESTIC-ESCROW ${state.installationId}`;
    },
  }),
  Object.freeze({
    id: "alarm_email",
    title: "Alarm email confirmation",
    requiredValues(state: SetupState) {
      return {
        alertEmail: state.config.alertEmail,
        action:
          "Confirm the SNS alarm-topic subscription email and keep the exercised-notification gate pending until later validation",
      };
    },
    buildPrompt(state: SetupState) {
      return [
        `Confirm the CloudWatch/SNS alarm email subscription for ${state.config.alertEmail}.`,
        "Open the confirmation link from AWS if still pending.",
        "Exercising a live notification remains a later production gate; this only confirms the subscription email.",
      ].join("\n");
    },
    confirmationPhrase(state: SetupState) {
      return `ALARM-EMAIL ${state.config.alertEmail}`;
    },
  }),
  Object.freeze({
    id: "ses_approval",
    title: "SES production-access approval",
    requiredValues(state: SetupState) {
      const production =
        state.aws && typeof state.aws === "object"
          ? (((state.aws as Record<string, unknown>).productionAccess as
              | Record<string, unknown>
              | undefined) ?? {})
          : {};
      return {
        region: state.config.awsRegion,
        status: String(production.status ?? production.reviewStatus ?? "unknown"),
        productionAccessEnabled: production.productionAccessEnabled === true,
      };
    },
    buildPrompt(state: SetupState) {
      const values = this.requiredValues(state);
      return [
        "SES production access is a regional AWS review gate outside CloudFormation.",
        `  Region: ${values.region}`,
        `  Recorded status: ${values.status}`,
        `  productionAccessEnabled: ${values.productionAccessEnabled}`,
        "Confirm AWS has approved production access for this account/region (sandbox is insufficient for production mail).",
      ].join("\n");
    },
    confirmationPhrase(state: SetupState) {
      return `SES-APPROVED ${state.config.awsAccountId} ${state.config.awsRegion}`;
    },
    isAlreadySatisfied(state: SetupState) {
      const production =
        state.aws && typeof state.aws === "object"
          ? (((state.aws as Record<string, unknown>).productionAccess as
              | Record<string, unknown>
              | undefined) ?? {})
          : {};
      return (
        production.productionAccessEnabled === true ||
        String(production.status ?? "").toLowerCase() === "granted" ||
        String(production.reviewStatus ?? "").toUpperCase() === "GRANTED"
      );
    },
  }),
]);

export type HumanGateProgress = {
  readonly id: string;
  readonly title: string;
  readonly complete: boolean;
  readonly autoSatisfied: boolean;
};

export function listHumanGateProgress(state: SetupState): HumanGateProgress[] {
  const stored = state.plans?.[DEPLOY_PLAN_KEY];
  const completed =
    stored && typeof stored === "object" && stored.completed && typeof stored.completed === "object"
      ? (stored.completed as Record<string, unknown>)
      : {};
  return HUMAN_GATE_DEFINITIONS.map((gate) => {
    const already =
      typeof gate.isAlreadySatisfied === "function" ? gate.isAlreadySatisfied(state) : false;
    const done = already || completed[gate.id] != null;
    return {
      id: gate.id,
      title: gate.title,
      complete: done,
      autoSatisfied: already && completed[gate.id] == null,
    };
  });
}

export type HumanGatesResult =
  | {
      readonly verified: true;
      readonly gates: readonly string[];
      readonly note?: string;
      readonly lastGate?: string;
    }
  | {
      readonly verified: false;
      readonly progress: true;
      readonly completedGate: string;
      readonly remaining: readonly string[];
    };

export type HumanGatesError =
  | SetupCommandError
  | SetupStoreError
  | CancellationError
  | TerminalError;

export type HumanGatesServices = SetupStoreService | TerminalService;

function ensureAutoSatisfiedGates(
  state: SetupState,
  env: PathEnvironment,
): Effect.Effect<SetupState, SetupStoreError, SetupStoreService> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    const previous = state.plans?.[DEPLOY_PLAN_KEY];
    const completed: Record<string, unknown> =
      previous &&
      typeof previous === "object" &&
      previous.completed &&
      typeof previous.completed === "object"
        ? { ...(previous.completed as Record<string, unknown>) }
        : {};
    let changed = false;
    for (const gate of HUMAN_GATE_DEFINITIONS) {
      if (completed[gate.id] != null) continue;
      if (typeof gate.isAlreadySatisfied === "function" && gate.isAlreadySatisfied(state)) {
        completed[gate.id] = sanitizePlanMetadata({
          completedAt: now,
          autoSatisfied: true,
          requiredValues: gate.requiredValues(state),
          note: "Satisfied from existing nonsecret AWS production-access evidence.",
        });
        changed = true;
      }
    }
    if (!changed) return state;
    const next: SetupState = {
      ...state,
      updatedAt: now,
      plans: {
        ...state.plans,
        [DEPLOY_PLAN_KEY]: sanitizePlanMetadata({
          completed,
          updatedAt: now,
        }),
      },
    };
    yield* store.writeState(next, env);
    return next;
  });
}

export function runHumanGatesStep(
  env: PathEnvironment = process.env,
  initialState?: SetupState,
): Effect.Effect<HumanGatesResult, HumanGatesError, HumanGatesServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId =
      initialState?.installationId ?? (yield* store.resolveInstallationId(env));
    let state = yield* store.loadState(installationId, env);

    let deployment: Record<string, string> = {};
    try {
      const loaded = yield* store.loadDeploymentEnv(installationId, env);
      deployment = plainDeploymentEnv(loaded);
    } catch {
      deployment = {};
    }

    state = yield* ensureAutoSatisfiedGates(state, env);

    const progress = listHumanGateProgress(state);
    const next = progress.find((gate) => !gate.complete);
    if (!next) {
      return {
        verified: true as const,
        gates: progress.map((gate) => gate.id),
        note: "All named human/external gates have nonsecret evidence.",
      };
    }

    const definition = HUMAN_GATE_DEFINITIONS.find((gate) => gate.id === next.id);
    if (!definition) {
      return yield* Effect.fail(
        new SetupCommandError({ message: `Unknown human gate ${next.id}.` }),
      );
    }

    const requiredValues = definition.requiredValues(state);
    const prompt =
      definition.id === "r2_bucket"
        ? definition.buildPrompt(state, deployment)
        : definition.buildPrompt(state);
    const phrase = definition.confirmationPhrase(state);

    yield* writeLine(`Human/external gate (one next action): ${definition.title}`);
    yield* writeLine(prompt);
    yield* writeLine("Required nonsecret values:");
    for (const [key, value] of Object.entries(requiredValues)) {
      yield* writeLine(`  ${key}=${value}`);
    }
    yield* writeLine(
      "The coordinator will not open provider consoles or mark this complete without your evidence phrase.",
    );
    yield* writeLine(`Type exactly: ${phrase}`);
    const answer = (yield* ask("Evidence confirmation: ", true)).trim();
    if (answer !== phrase) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Evidence rejected for gate "${definition.id}". Type exactly: ${phrase}`,
        }),
      );
    }

    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    const previous = state.plans?.[DEPLOY_PLAN_KEY];
    const completed: Record<string, unknown> =
      previous &&
      typeof previous === "object" &&
      previous.completed &&
      typeof previous.completed === "object"
        ? { ...(previous.completed as Record<string, unknown>) }
        : {};
    completed[definition.id] = sanitizePlanMetadata({
      completedAt: now,
      phrase,
      requiredValues,
    });

    const nextState: SetupState = {
      ...state,
      updatedAt: now,
      plans: {
        ...state.plans,
        [DEPLOY_PLAN_KEY]: sanitizePlanMetadata({
          completed,
          updatedAt: now,
        }),
      },
    };
    yield* store.writeState(nextState, env);
    state = nextState;

    const remaining = listHumanGateProgress(state).filter((gate) => !gate.complete);
    if (remaining.length === 0) {
      return {
        verified: true as const,
        gates: listHumanGateProgress(state).map((gate) => gate.id),
        lastGate: definition.id,
      };
    }

    yield* writeLine(
      `Recorded evidence for "${definition.id}". ${remaining.length} human/external gate(s) remain. Rerun continue for the next action.`,
    );
    return {
      verified: false as const,
      progress: true as const,
      completedGate: definition.id,
      remaining: remaining.map((gate) => gate.id),
    };
  });
}
