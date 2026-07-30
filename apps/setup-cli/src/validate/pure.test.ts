import { describe, expect, it } from "vitest";

import { BASE_REQUIRED_READINESS_IDS, MARKETING_REQUIRED_READINESS_IDS } from "./constants.ts";
import {
  assertDlqEmpty,
  assertProtectedSuppression,
  assertReadinessPayload,
  assertSimulatorStageEvidence,
  parseSimulatorResult,
  requiredReadinessIds,
} from "./pure.ts";

function sampleState(marketingEnabled = false) {
  return {
    schemaVersion: 1 as const,
    installationId: "prod",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    config: {
      releaseTag: "v0.1.1",
      domain: "mail.example.com",
      ingressMode: "direct" as const,
      ownerEmail: "owner@example.com",
      ownerName: "Owner",
      awsProfile: "nusend-provisioner",
      awsRegion: "us-east-1",
      awsAccountId: "123456789012",
      sesIdentity: "example.com",
      sesFromEmail: "sender@example.com",
      marketingEnabled,
      trackingEnabled: false,
      alertEmail: "alerts@example.com",
      route53HostedZoneId: null,
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      installationName: "prod",
    },
    stages: {},
    plans: {},
  };
}

describe("validate pure helpers", () => {
  it("selects transactional and configured marketing readiness IDs", () => {
    expect(requiredReadinessIds(sampleState())).toEqual([...BASE_REQUIRED_READINESS_IDS]);
    expect(requiredReadinessIds(sampleState(true))).toEqual([
      ...BASE_REQUIRED_READINESS_IDS,
      ...MARKETING_REQUIRED_READINESS_IDS,
    ]);
    expect(requiredReadinessIds(sampleState(true), true)).toContain("operations.latest_feedback");
  });

  it("rejects missing, duplicate, and non-ok required readiness checks", () => {
    expect(
      assertReadinessPayload(
        {
          checks: BASE_REQUIRED_READINESS_IDS.map((id) => ({ id, status: "ok" })),
        },
        BASE_REQUIRED_READINESS_IDS,
      ),
    ).toMatchObject({ requiredIds: BASE_REQUIRED_READINESS_IDS });
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

  it("rejects simulator non-validated, malformed, and incomplete stored evidence", () => {
    expect(() => parseSimulatorResult('{"status":"timed_out"}', "bounce")).toThrow(/timed_out/);
    expect(() => parseSimulatorResult("not-json", "bounce")).toThrow(/no valid JSON/);
    expect(
      parseSimulatorResult(
        JSON.stringify({
          status: "validated",
          runId: "run-bounce",
          recipientEmail: "bounce@simulator.amazonses.com",
        }),
        "bounce",
      ),
    ).toMatchObject({ scenario: "bounce", status: "validated" });
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

  it("requires protected global suppressions and empty DLQ counters", () => {
    expect(() =>
      assertProtectedSuppression({ items: [] }, "complaint", "complaint@simulator.amazonses.com"),
    ).toThrow(/complaint suppression/);
    expect(
      assertProtectedSuppression(
        {
          items: [
            {
              email: "bounce@simulator.amazonses.com",
              scope: "all",
              reason: "bounce",
            },
          ],
        },
        "bounce",
        "bounce@simulator.amazonses.com",
      ),
    ).toMatchObject({ email: "bounce@simulator.amazonses.com", reason: "bounce" });
    expect(() => assertDlqEmpty({ visible: 0, notVisible: 0, delayed: 0 })).not.toThrow();
    expect(() => assertDlqEmpty({ visible: 1, notVisible: 0, delayed: 0 })).toThrow(
      /DLQ is not empty/,
    );
  });
});
