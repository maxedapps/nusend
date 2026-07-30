import { describe, expect, it } from "vitest";

import {
  RETAINED_RESOURCES,
  assertInitialStackCreationProof,
  buildDestroyConfirmationPhrase,
  fingerprintDestroyPlan,
  validateDestroyConfirmation,
} from "./pure.ts";
import { KEY_ID, STACK_ID, stackOutputs } from "./test-harness.ts";

describe("destroy ownership, phrase, and fingerprint", () => {
  it("accepts only immutable coordinator core CREATE proof and exact confirmation", () => {
    const state = {
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
        marketingEnabled: false,
        trackingEnabled: false,
        alertEmail: "alerts@example.com",
        route53HostedZoneId: null,
        sshTarget: "root@203.0.113.10",
        remotePath: "/srv/nusend",
        installationName: "prod",
      },
      stages: {},
      plans: {},
      aws: {
        runtimeAccessKeyId: KEY_ID,
        stackCreation: {
          provenance: "coordinator-reviewed-change-set",
          phase: "core",
          changeSetType: "CREATE",
          stackId: STACK_ID,
          stackName: "nusend-prod",
          accountId: "123456789012",
          partition: "aws",
          region: "us-east-1",
          changeSetArn:
            "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/create-id",
          fingerprint: "a".repeat(64),
          appliedAt: "2026-01-01T00:00:00.000Z",
        },
        stack: {
          stackId: STACK_ID,
          stackName: "nusend-prod",
          accountId: "123456789012",
          partition: "aws",
          region: "us-east-1",
          phase: "finalize",
          status: "UPDATE_COMPLETE",
          outputs: stackOutputs(),
        },
      },
    };

    expect(assertInitialStackCreationProof(state as never)).toMatchObject({
      stackId: STACK_ID,
      stackName: "nusend-prod",
      accountId: "123456789012",
      partition: "aws",
      region: "us-east-1",
    });

    const phrase = buildDestroyConfirmationPhrase({
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      domain: "mail.example.com",
      sshTarget: "root@203.0.113.10",
    });
    expect(phrase).toBe(
      "DESTROY 123456789012 us-east-1 nusend-prod mail.example.com root@203.0.113.10",
    );
    expect(() =>
      validateDestroyConfirmation(phrase, {
        accountId: "123456789012",
        region: "us-east-1",
        stackName: "nusend-prod",
        domain: "mail.example.com",
        sshTarget: "root@203.0.113.10",
      }),
    ).not.toThrow();
    expect(() =>
      validateDestroyConfirmation("DESTROY wrong", {
        accountId: "123456789012",
        region: "us-east-1",
        stackName: "nusend-prod",
        domain: "mail.example.com",
        sshTarget: "root@203.0.113.10",
      }),
    ).toThrow(/Confirmation rejected/);

    expect(() =>
      assertInitialStackCreationProof({
        ...state,
        aws: { ...state.aws, stackCreation: undefined },
      } as never),
    ).toThrow(/unproven|CREATE proof/i);
  });

  it("fingerprints all reviewed plan evidence and rejects stale mutation", () => {
    const plan = {
      version: 2,
      installationId: "prod",
      accountId: "123456789012",
      partition: "aws",
      region: "us-east-1",
      stackId: STACK_ID,
      stackName: "nusend-prod",
      stackStatus: "UPDATE_COMPLETE",
      stackExists: true,
      stackLastUpdatedTime: "2026-01-01T00:00:00.000Z",
      domain: "mail.example.com",
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      runtimeUserName: "nusend-prod-runtime",
      runtimeAccessKeyId: KEY_ID,
      runtimeKeys: [{ accessKeyId: KEY_ID, status: "Active" }],
      dlq: { visible: 0, notVisible: 0, delayed: 0 },
      stackResources: [],
      subscriptions: { feedback: [], alarm: [] },
      alarms: [],
      remote: { reachable: true, status: "inspected" },
      retainedResources: [...RETAINED_RESOURCES],
      externalDkimRecords: [],
      creationProofFingerprint: "a".repeat(64),
      plannedAt: "2026-01-01T00:00:00.000Z",
    };
    const fingerprint = fingerprintDestroyPlan(plan);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintDestroyPlan(plan)).toBe(fingerprint);
    expect(fingerprintDestroyPlan({ ...plan, region: "eu-west-1" })).not.toBe(fingerprint);
  });
});
