export const sesSnsWebhookPath = "/api/webhooks/aws/sns/ses";

export const sesDocs = {
  engagementTracking: "docs/deployment.md#engagement-tracking",
  observability: "docs/deployment.md#operations-and-monitoring",
  productionReadiness: "docs/deployment.md#pre-volume-gates",
  readiness: "docs/deployment.md#ses-readiness",
  setup: "docs/deployment.md#aws-ses-and-sns-setup",
  simulator: "docs/deployment.md#ses-simulator-validation",
} as const;
