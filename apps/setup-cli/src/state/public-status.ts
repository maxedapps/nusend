import { sanitizePlanMetadata } from "./sanitize.ts";
import type { AwsSsoAuth, ProvisionerPolicyRecord, SetupState } from "./schema.ts";

export type PublicStatusView = {
  readonly installationId: string;
  readonly schemaVersion: 1 | 2;
  readonly updatedAt: string;
  readonly config: SetupState["config"];
  readonly stages: Record<
    string,
    {
      readonly status: "complete";
      readonly completedAt: string;
      readonly evidence: Record<string, unknown>;
    }
  >;
  readonly plans: Record<string, Record<string, unknown>>;
  readonly aws?: Record<string, unknown>;
  readonly deploy?: Record<string, unknown>;
  readonly provisionerPolicy?: ProvisionerPolicyRecord;
  readonly awsAuth?: AwsSsoAuth;
};

/**
 * Public status projection: never includes secret env values or secret-shaped keys.
 */
export function publicStatusView(state: SetupState): PublicStatusView {
  return {
    installationId: state.installationId,
    schemaVersion: state.schemaVersion,
    updatedAt: state.updatedAt,
    config: { ...state.config },
    stages: Object.fromEntries(
      Object.entries(state.stages).map(([id, checkpoint]) => [
        id,
        {
          status: checkpoint.status,
          completedAt: checkpoint.completedAt,
          evidence: sanitizePlanMetadata(checkpoint.evidence),
        },
      ]),
    ),
    plans: Object.fromEntries(
      Object.entries(state.plans).map(([id, plan]) => [id, sanitizePlanMetadata(plan)]),
    ),
    ...(state.aws ? { aws: sanitizePlanMetadata(state.aws as Record<string, unknown>) } : {}),
    ...(state.deploy
      ? { deploy: sanitizePlanMetadata(state.deploy as Record<string, unknown>) }
      : {}),
    ...(state.provisionerPolicy ? { provisionerPolicy: { ...state.provisionerPolicy } } : {}),
    ...(state.schemaVersion === 2 ? { awsAuth: { ...state.awsAuth } } : {}),
  };
}
