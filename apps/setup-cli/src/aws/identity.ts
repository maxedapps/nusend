import { Clock, Effect } from "effect";

import { SetupStore } from "../services/setup-store.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import {
  getEmailIdentity,
  getSesAccount,
  type AwsWorkflowError,
  type AwsWorkflowServices,
} from "./ops.ts";
import {
  summarizeIdentity,
  summarizeProductionAccessStatus,
  type IdentitySummary,
} from "./pure.ts";

export function refreshAndStoreIdentity(
  state: SetupState,
  env: PathEnvironment = process.env,
  options: { readonly persist?: boolean } = {},
): Effect.Effect<IdentitySummary, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const payload = yield* getEmailIdentity(state, env);
    const summary = summarizeIdentity(payload);
    if (options.persist !== false) {
      const store = yield* SetupStore;
      const nowMillis = yield* Clock.currentTimeMillis;
      const now = new Date(nowMillis).toISOString();
      const next: SetupState = {
        ...state,
        updatedAt: now,
        aws: sanitizePlanMetadata({
          ...(state.aws ?? {}),
          identity: { ...summary, checkedAt: now },
        }) as SetupState["aws"],
      };
      yield* store.writeState(next, env);
      return summary;
    }
    return summary;
  });
}

export function refreshProductionAccessStatus(
  state: SetupState,
  env: PathEnvironment = process.env,
  options: { readonly persist?: boolean } = {},
): Effect.Effect<Record<string, unknown>, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const payload = yield* getSesAccount(state, env);
    const summary = summarizeProductionAccessStatus(payload);
    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    const productionAccess: Record<string, unknown> = {
      ...(state.aws?.productionAccess ?? {}),
      ...summary,
      checkedAt: now,
    };
    if (summary.productionAccessEnabled) {
      productionAccess.status = "approved";
    } else if (summary.reviewStatus === "PENDING") {
      productionAccess.status = "pending";
    } else if (productionAccess.status == null) {
      productionAccess.status = "not_submitted";
    }
    if (options.persist !== false) {
      const store = yield* SetupStore;
      const next: SetupState = {
        ...state,
        updatedAt: now,
        aws: sanitizePlanMetadata({
          ...(state.aws ?? {}),
          productionAccess,
        }) as SetupState["aws"],
      };
      yield* store.writeState(next, env);
    }
    return productionAccess;
  });
}
