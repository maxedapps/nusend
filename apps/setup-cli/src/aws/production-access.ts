import { Clock, Effect } from "effect";

import { ask, askBoolean, writeLine } from "../commands/prompts.ts";
import { SetupCommandError } from "../errors.ts";
import { SetupStore } from "../services/setup-store.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import { PRODUCTION_BRIEF_FIELDS, REQUEST_PRODUCTION_ACCESS_PHRASE } from "./constants.ts";
import { refreshProductionAccessStatus } from "./identity.ts";
import {
  asCommandError,
  putAccountDetails,
  resolveCallerContext,
  type AwsWorkflowError,
  type AwsWorkflowServices,
} from "./ops.ts";
import { buildUseCaseDescription, validateProductionBrief } from "./pure.ts";

export type ProductionAccessRequestResult = {
  readonly status: string;
  readonly productionAccess: unknown;
};

export function runProductionAccessRequest(
  env: PathEnvironment = process.env,
  options: {
    readonly existingState?: SetupState;
    readonly brief?: Record<string, unknown>;
    readonly submitEnabled?: boolean;
    readonly confirmation?: string;
  } = {},
): Effect.Effect<ProductionAccessRequestResult, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId =
      options.existingState?.installationId ?? (yield* store.resolveInstallationId(env));
    let state = options.existingState ?? (yield* store.loadState(installationId, env));
    yield* resolveCallerContext(state, env);

    const status = yield* refreshProductionAccessStatus(state, env, { persist: true });
    state = yield* store.loadState(installationId, env);

    if (status.productionAccessEnabled === true || status.status === "approved") {
      yield* writeLine(
        "SES production access is already approved in this region (read-only gate).",
      );
      return { status: "approved", productionAccess: state.aws?.productionAccess };
    }
    if (status.reviewStatus === "PENDING" || status.status === "pending") {
      yield* writeLine("SES production access request is PENDING. Not resubmitting.");
      return { status: "pending", productionAccess: state.aws?.productionAccess };
    }

    const submitEnabled =
      options.submitEnabled ??
      (yield* askBoolean("Submit SES production-access request now?", false));
    if (!submitEnabled) {
      yield* writeLine(
        "Production-access submission skipped (operator did not enable submission).",
      );
      return { status: "skipped", productionAccess: state.aws?.productionAccess };
    }

    const briefInput = options.brief ?? (yield* collectProductionBriefInteractive());
    let brief: Record<string, string>;
    try {
      brief = validateProductionBrief(briefInput);
    } catch (error) {
      return yield* Effect.fail(asCommandError(error));
    }
    const confirmation =
      options.confirmation ?? (yield* ask(`Type ${REQUEST_PRODUCTION_ACCESS_PHRASE} to submit: `));
    if (String(confirmation).trim() !== REQUEST_PRODUCTION_ACCESS_PHRASE) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Confirmation rejected. Type exactly: ${REQUEST_PRODUCTION_ACCESS_PHRASE}`,
        }),
      );
    }

    const useCaseDescription = buildUseCaseDescription(brief);
    yield* putAccountDetails(
      state,
      [
        "sesv2",
        "put-account-details",
        "--production-access-enabled",
        "--mail-type",
        brief.mailType,
        "--website-url",
        brief.website,
        "--contact-language",
        brief.contactLanguage,
        "--use-case-description",
        useCaseDescription,
        "--additional-contact-email-addresses",
        state.config.ownerEmail,
        "--output",
        "json",
      ],
      env,
    );

    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    const next: SetupState = {
      ...state,
      updatedAt: now,
      aws: sanitizePlanMetadata({
        ...(state.aws ?? {}),
        productionAccess: {
          status: "pending",
          productionAccessEnabled: false,
          reviewStatus: "PENDING",
          submittedAt: now,
          checkedAt: now,
          brief: {
            website: brief.website,
            mailType: brief.mailType,
            contactLanguage: brief.contactLanguage,
            useCase: brief.useCase,
            expectedVolume: brief.expectedVolume,
            frequency: brief.frequency,
            recipientConsent: brief.recipientConsent.slice(0, 200),
            unsubscribe: brief.unsubscribe.slice(0, 200),
            bounceComplaintHandling: brief.bounceComplaintHandling.slice(0, 200),
            formAbuseControls: brief.formAbuseControls.slice(0, 200),
            monitoring: brief.monitoring.slice(0, 200),
          },
        },
      }) as SetupState["aws"],
    };
    yield* store.writeState(next, env);
    yield* writeLine(
      "SES production-access request submitted. Approval is an external regional gate.",
    );
    return { status: "submitted", productionAccess: next.aws?.productionAccess };
  });
}

function collectProductionBriefInteractive(): Effect.Effect<
  Record<string, string>,
  AwsWorkflowError,
  AwsWorkflowServices
> {
  return Effect.gen(function* () {
    const brief: Record<string, string> = {};
    const prompts: Record<(typeof PRODUCTION_BRIEF_FIELDS)[number], string> = {
      website: "Website URL (https://): ",
      useCase: "Use case description: ",
      mailType: "Mail type (TRANSACTIONAL|MARKETING): ",
      expectedVolume: "Expected volume: ",
      frequency: "Sending frequency: ",
      recipientConsent: "Recipient consent/acquisition: ",
      unsubscribe: "Unsubscribe handling: ",
      bounceComplaintHandling: "Bounce/complaint handling: ",
      formAbuseControls: "Form-abuse controls: ",
      monitoring: "Monitoring: ",
      contactLanguage: "Contact language (e.g. EN): ",
    };
    for (const field of PRODUCTION_BRIEF_FIELDS) {
      brief[field] = yield* ask(prompts[field]);
    }
    return brief;
  });
}
