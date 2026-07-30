import { Clock, Effect } from "effect";

import { writeLine } from "../commands/prompts.ts";
import { SetupCommandError } from "../errors.ts";
import { SetupStore } from "../services/setup-store.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { PathEnvironment } from "../state/paths.ts";
import { AWS_PLAN_KEY, REQUIRED_CAPABILITY, defaultStackTemplatePath } from "./constants.ts";
import {
  assertExistingCoreStackProvenance,
  createChangeSet,
  deleteAbandonedChangeSet,
  describeStack,
  loadStackTemplate,
  makeStateRunner,
  requireNonActiveStack,
  resolveCallerContext,
  validateTemplate,
  waitForChangeSet,
  type AwsWorkflowError,
  type AwsWorkflowServices,
} from "./ops.ts";
import {
  buildApplyConfirmationPhrase,
  buildChangeSetName,
  buildStackName,
  buildStackParameters,
  determinePhase,
  fingerprintTemplateAndParameters,
  summarizeChangeSet,
} from "./pure.ts";
import { assertPreFinalizeSubscriptionAbsence } from "./subscription.ts";

export type AwsPlanResult = {
  readonly plan: Record<string, unknown>;
  readonly summary: ReturnType<typeof summarizeChangeSet>;
  readonly caller: {
    readonly accountId: string;
    readonly partition: string;
    readonly region: string;
  };
};

export function runAwsPlan(
  env: PathEnvironment = process.env,
  options: { readonly templatePath?: string } = {},
): Effect.Effect<AwsPlanResult, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);
    const caller = yield* resolveCallerContext(state, env);
    const phase = determinePhase(state);

    if (phase === "finalize") {
      const run = yield* makeStateRunner(state);
      yield* assertPreFinalizeSubscriptionAbsence(state, run, env);
    }

    const stackName = buildStackName(state.installationId);
    const parameters = buildStackParameters(state, phase);
    const templatePath = options.templatePath ?? defaultStackTemplatePath();
    const template = yield* loadStackTemplate(templatePath);
    yield* validateTemplate(state, template.path, env);

    const existing = yield* describeStack(state, stackName, env);
    yield* requireNonActiveStack(stackName, existing.status);

    if (phase === "core" && existing.exists) {
      yield* assertExistingCoreStackProvenance(state, existing, caller, stackName);
    }

    const changeSetType = existing.exists ? "UPDATE" : "CREATE";
    const fingerprint = fingerprintTemplateAndParameters(template.body, parameters, {
      stackName,
      phase,
    });
    const changeSetName = buildChangeSetName(state.installationId, phase);

    const previousPlan = state.plans?.[AWS_PLAN_KEY] as Record<string, unknown> | undefined;
    yield* deleteAbandonedChangeSet(state, stackName, changeSetName, previousPlan, env);

    const parameterArgs = parameters.flatMap((entry) => [
      "ParameterKey=" + entry.ParameterKey + ",ParameterValue=" + entry.ParameterValue,
    ]);

    const createArgs = [
      "cloudformation",
      "create-change-set",
      "--stack-name",
      stackName,
      "--change-set-name",
      changeSetName,
      "--change-set-type",
      changeSetType,
      "--template-body",
      `file://${template.path}`,
      "--parameters",
      ...parameterArgs,
      "--capabilities",
      REQUIRED_CAPABILITY,
      "--output",
      "json",
    ];

    const { changeSetArn } = yield* createChangeSet(state, createArgs, env);
    const described = yield* waitForChangeSet(state, changeSetArn, env);
    const summary = summarizeChangeSet(described);
    const noChange = summary.noChange;
    if (!noChange && summary.status !== "CREATE_COMPLETE") {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Change set ${changeSetName} ended in status ${summary.status}: ${summary.statusReason}`,
        }),
      );
    }

    yield* writeLine(`AWS plan (${phase}/${changeSetType}) for stack ${stackName}`);
    yield* writeLine(
      `  account=${caller.accountId} partition=${caller.partition} region=${caller.region}`,
    );
    yield* writeLine(`  changeSet=${changeSetArn}`);
    yield* writeLine(`  capability=${REQUIRED_CAPABILITY}`);
    if (noChange) {
      yield* writeLine("  result=NO_CHANGES (stack already matches template/parameters)");
    } else {
      yield* writeLine(
        `  resources=${summary.resourceCount} replacements=${summary.replacements} iam=${summary.iamChanges}`,
      );
      if (summary.replacements > 0) {
        yield* writeLine("  WARNING: one or more resources will be replaced.");
      }
      for (const resource of summary.resources) {
        yield* writeLine(
          `  - ${resource.action} ${resource.logicalId} (${resource.type}) replacement=${resource.replacement}`,
        );
      }
    }

    const nowMillis = yield* Clock.currentTimeMillis;
    const plannedAt = new Date(nowMillis).toISOString();
    const plan = sanitizePlanMetadata({
      changeSetArn,
      changeSetName,
      stackName,
      stackId: summary.stackId || existing.stackId || null,
      phase,
      changeSetType,
      fingerprint,
      accountId: caller.accountId,
      partition: caller.partition,
      region: caller.region,
      noChange,
      plannedAt,
      capability: REQUIRED_CAPABILITY,
      resourceCount: summary.resourceCount,
      replacements: summary.replacements,
      iamChanges: summary.iamChanges,
    });

    const next = {
      ...state,
      updatedAt: plannedAt,
      plans: {
        ...state.plans,
        [AWS_PLAN_KEY]: plan,
      },
    };
    yield* store.writeState(next, env);
    yield* writeLine(
      "Plan stored. Review, then run `pnpm nusend:setup aws apply` and type the confirmation phrase.",
    );
    yield* writeLine(
      `Expected confirmation: ${buildApplyConfirmationPhrase({
        accountId: caller.accountId,
        region: caller.region,
        stackName,
        phase,
      })}`,
    );
    return { plan, summary, caller };
  });
}
