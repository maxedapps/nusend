import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { dispatchCommand } from "../commands/dispatch.ts";
import { SetupStore, SetupStoreFake, SetupStoreLive } from "../services/setup-store.ts";
import { PROVISIONER_POLICY_FILE_NAME } from "../state/constants.ts";
import { policyArtifactPath } from "../state/paths.ts";
import type { SetupStateV2 } from "../state/schema.ts";
import { TerminalFake } from "../terminal.ts";
import { ProcessRunnerFake } from "../process-runner.ts";
import { AwsCliFake } from "../auth/aws-cli.ts";
import {
  AwsPermissionDeniedError,
  extractActionHint,
  formatDedicatedAssignmentAttestationPrompt,
  formatPermissionHandoff,
  formatProvisionerCleanupGuidance,
  isAwsAuthorizationDenialText,
  mapAccessDeniedToHandoff,
  runAwsPermissionsCommand,
  writePolicyArtifactAndRecord,
} from "./permissions.ts";
import { suggestedPermissionSetName } from "./provisioning-policy.ts";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "nusend-perm-"));
  temps.push(home);
  return { ...process.env, NUSEND_SETUP_HOME: home };
}

function sampleState(overrides: Partial<SetupStateV2> = {}): SetupStateV2 {
  const now = "2026-06-01T00:00:00.000Z";
  const base: SetupStateV2 = {
    schemaVersion: 2,
    installationId: "demo",
    createdAt: now,
    updatedAt: now,
    config: {
      releaseTag: "v0.1.0",
      domain: "mail.example.com",
      ingressMode: "direct",
      ownerEmail: "owner@example.com",
      ownerName: "Owner",
      awsProfile: "nusend-demo",
      awsRegion: "eu-west-1",
      awsAccountId: "123456789012",
      sesIdentity: "example.com",
      sesFromEmail: "noreply@example.com",
      marketingEnabled: false,
      trackingEnabled: false,
      alertEmail: "alerts@example.com",
      route53HostedZoneId: null,
      sshTarget: "deploy@host",
      remotePath: "/srv/nusend",
      installationName: "demo",
    },
    stages: {
      init: {
        status: "complete",
        completedAt: now,
        evidence: { verified: true, installationId: "demo" },
      },
    },
    plans: {
      aws_core: {
        kind: "aws",
        changeSetName: "nusend-demo-core",
        changeSetArn:
          "arn:aws:cloudformation:eu-west-1:123456789012:changeSet/nusend-demo-core/abc",
        templateFingerprint: "fp-template-keep",
        parameterFingerprint: "fp-params-keep",
        phase: "CREATE",
      },
    },
    awsAuth: {
      type: "sso",
      profileName: "nusend-demo",
      ssoSessionName: "nusend-demo-sso",
      accountId: "123456789012",
      roleName: "NusendProvisioner",
      identityCenterRegion: "us-east-1",
      partition: "aws",
      verifiedAccountId: "123456789012",
      verifiedAt: now,
      boundAt: now,
    },
  };
  return {
    ...base,
    ...overrides,
    config: { ...base.config, ...(overrides.config ?? {}) },
    plans: { ...base.plans, ...(overrides.plans ?? {}) },
    awsAuth: { ...base.awsAuth, ...(overrides.awsAuth ?? {}) },
    stages: { ...base.stages, ...(overrides.stages ?? {}) },
  };
}

async function seedState(env: NodeJS.ProcessEnv, state: SetupStateV2): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      yield* store.reserveInstallationDirectory(state.installationId, env);
      yield* store.writeState(state, env);
      yield* store.writeCurrentPointer(state.installationId, env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

describe("extractActionHint / authorization text", () => {
  it("extracts safe action hints and detects AccessDenied shapes", () => {
    expect(
      extractActionHint(
        "User: arn:aws:sts::123:assumed-role/x is not authorized to perform: cloudformation:CreateChangeSet on resource",
      ),
    ).toBe("cloudformation:CreateChangeSet");
    expect(extractActionHint("AccessDenied: not authorized to perform: iam:CreateAccessKey")).toBe(
      "iam:CreateAccessKey",
    );
    expect(extractActionHint("something unrelated failed")).toBeNull();
    expect(isAwsAuthorizationDenialText("An error occurred (AccessDenied) when calling")).toBe(
      true,
    );
    expect(isAwsAuthorizationDenialText("UnauthorizedOperation: you are not authorized")).toBe(
      true,
    );
    expect(isAwsAuthorizationDenialText("Token has expired and refresh failed")).toBe(false);
  });
});

describe("formatPermissionHandoff", () => {
  it("prints context, honesty limits, IC steps, placeholders, and prohibits AWSReservedSSO edits", () => {
    const text = formatPermissionHandoff({
      profileName: "nusend-demo",
      accountId: "123456789012",
      roleName: "NusendProvisioner",
      region: "eu-west-1",
      partition: "aws",
      installationId: "demo",
      artifactPath: "/tmp/nusend-provisioner-policy.json",
      fingerprintSha256: "abc123",
      operationHint: "cloudformation create-change-set",
      actionHint: "cloudformation:CreateChangeSet",
    });

    expect(text).toContain("profile:   nusend-demo");
    expect(text).toContain("account:   123456789012");
    expect(text).toContain("role:      NusendProvisioner");
    expect(text).toContain("region:    eu-west-1");
    expect(text).toContain("cloudformation create-change-set");
    expect(text).toContain("cloudformation:CreateChangeSet");
    expect(text).toContain("no universally available complete preflight");
    expect(text).toContain("Write permissions are not fully verifiable");
    expect(text).toContain(suggestedPermissionSetName("demo"));
    expect(text).toContain("Do NOT edit AWSReservedSSO_");
    expect(text).toContain("not something this wizard can grant");
    expect(text).toContain("sha256:abc123");
    expect(text).toContain("sso-admin put-inline-policy-to-permission-set");
    expect(text).toContain("<IDENTITY_CENTER_INSTANCE_ARN>");
    expect(text).toContain("<PERMISSION_SET_ARN>");
    expect(text).toContain("file:///tmp/nusend-provisioner-policy.json");
    expect(text).not.toMatch(/sso-admin delete|sso logout|AWSReservedSSO_.*PutRolePolicy/i);
  });

  it("uses supplied instance/permission-set ARNs when independently known", () => {
    const text = formatPermissionHandoff({
      profileName: "p",
      accountId: "1".repeat(12),
      roleName: "R",
      region: "us-east-1",
      partition: "aws",
      installationId: "x",
      artifactPath: "/a.json",
      fingerprintSha256: "f",
      instanceArn: "arn:aws:sso:::instance/ssoins-abc",
      permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-abc/ps-1",
    });
    expect(text).toContain("arn:aws:sso:::instance/ssoins-abc");
    expect(text).toContain("arn:aws:sso:::permissionSet/ssoins-abc/ps-1");
    expect(text).not.toContain("<IDENTITY_CENTER_INSTANCE_ARN>");
  });
});

describe("cleanup guidance and attestation", () => {
  it("distinguishes dedicated vs pre-existing and never mutates SSO admin", () => {
    const dedicated = formatProvisionerCleanupGuidance({
      dedicatedTemporaryAssignment: true,
      installationId: "demo",
    });
    expect(dedicated).toContain("dedicated temporary assignment");
    expect(dedicated).toContain("Remove the account assignment");
    expect(dedicated).toContain("does not call sso-admin");
    expect(dedicated).toMatch(/never invokes global SSO logout/i);
    expect(dedicated).not.toMatch(/delete-account-assignment/i);
    // Guidance may mention logout only to prohibit it; never instruct running logout.
    expect(dedicated).not.toMatch(/run aws sso logout|aws sso logout --/i);

    const preexisting = formatProvisionerCleanupGuidance({
      dedicatedTemporaryAssignment: false,
      installationId: "demo",
    });
    expect(preexisting).toContain("pre-existing");
    expect(preexisting).toContain("owns nothing to remove");
    expect(preexisting).not.toMatch(/sso-admin|logout|delete-permission/i);

    const unknown = formatProvisionerCleanupGuidance({
      dedicatedTemporaryAssignment: null,
      installationId: "demo",
    });
    expect(unknown).toContain("was not recorded");

    const attestation = formatDedicatedAssignmentAttestationPrompt();
    expect(attestation).toMatch(/Attest|cannot verify/i);
  });
});

describe("AccessDenied handoff preserves plans", () => {
  it("writes artifact, returns typed denial, and keeps change-set plan intact", async () => {
    const env = tempEnv();
    const state = sampleState();
    await seedState(env, state);

    const denied = await Effect.runPromise(
      mapAccessDeniedToHandoff(state, {
        env,
        operationHint: "cloudformation create-change-set",
        errorText:
          "An error occurred (AccessDenied) when calling the CreateChangeSet operation: User is not authorized to perform: cloudformation:CreateChangeSet",
      }).pipe(Effect.provide(SetupStoreLive)),
    );

    expect(denied).toBeInstanceOf(AwsPermissionDeniedError);
    expect(denied._tag).toBe("AwsPermissionDeniedError");
    expect(denied.operationHint).toBe("cloudformation create-change-set");
    expect(denied.actionHint).toBe("cloudformation:CreateChangeSet");
    expect(denied.handoff.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(denied.handoff.permissionSetName).toBe("NusendProvisioner-demo");
    expect(denied.message).toMatch(/Plans were not consumed/i);

    const reloaded = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        return yield* store.loadState("demo", env);
      }).pipe(Effect.provide(SetupStoreLive)),
    );

    expect(reloaded.plans.aws_core).toEqual(state.plans.aws_core);
    expect(reloaded.provisionerPolicy?.fileName).toBe(PROVISIONER_POLICY_FILE_NAME);
    expect(reloaded.provisionerPolicy?.fingerprintSha256).toBe(denied.handoff.fingerprintSha256);

    const artifact = readFileSync(policyArtifactPath("demo", env), "utf8");
    expect(JSON.parse(artifact).Version).toBe("2012-10-17");
    if (process.platform !== "win32") {
      expect(statSync(policyArtifactPath("demo", env)).mode & 0o777).toBe(0o600);
    }
  });

  it("unit handoff with fake store preserves in-memory plans", async () => {
    const state = sampleState();
    let writtenState: SetupStateV2 | undefined;
    let writtenPolicy: string | undefined;

    const layer = SetupStoreFake({
      writeState: (next) => {
        writtenState = next as SetupStateV2;
        return Effect.succeed(next);
      },
      writePolicyArtifact: (_id, policyJson) => {
        writtenPolicy = policyJson;
        return Effect.void;
      },
    });

    const result = await Effect.runPromise(
      writePolicyArtifactAndRecord(state, {
        env: { NUSEND_SETUP_HOME: "/tmp/unused" },
        dedicatedTemporaryAssignment: false,
        operationHint: "ses put-account-details",
        actionHint: "ses:PutAccountDetails",
      }).pipe(Effect.provide(layer)),
    );

    expect(writtenPolicy).toContain("Version");
    expect(writtenState).toBeDefined();
    expect(writtenState!.plans.aws_core).toEqual(state.plans.aws_core);
    expect(writtenState!.provisionerPolicy?.dedicatedTemporaryAssignment).toBe(false);
    expect(result.handoffText).toContain("ses put-account-details");
    expect(result.handoffText).toContain("ses:PutAccountDetails");
    expect(result.summary.dedicatedTemporaryAssignment).toBe(false);
  });
});

describe("aws permissions command", () => {
  it("renders artifact, records dedicated flag, and prints handoff without sso-admin mutations", async () => {
    const env = tempEnv();
    await seedState(env, sampleState());

    const terminal = TerminalFake({
      answers: ["y"],
    });
    const layer = Layer.mergeAll(
      terminal.layer,
      SetupStoreLive,
      ProcessRunnerFake(),
      AwsCliFake({}),
    );

    const result = await Effect.runPromise(
      runAwsPermissionsCommand(env).pipe(Effect.provide(layer)),
    );

    expect(result.rendered.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.record.dedicatedTemporaryAssignment).toBe(true);
    expect(result.state.plans.aws_core).toBeTruthy();

    const stdout = terminal.state.stdout.join("");
    expect(stdout).toContain("permission handoff");
    expect(stdout).toContain("NusendProvisioner-demo");
    expect(stdout).toContain("cleanup guidance");
    expect(stdout).toContain("dedicated temporary assignment");
    expect(stdout).toMatch(/never invokes global SSO logout|never creates, updates, deletes/i);
    expect(stdout).not.toMatch(/delete-account-assignment|delete-permission-set/i);
    expect(stdout).not.toMatch(/run aws sso logout|aws sso logout --/i);
    expect(stdout).toContain("never creates, updates, deletes");

    // dispatch path
    const terminal2 = TerminalFake({ answers: ["n"] });
    const layer2 = Layer.mergeAll(
      terminal2.layer,
      SetupStoreLive,
      ProcessRunnerFake(),
      AwsCliFake({}),
    );
    const exit = await Effect.runPromiseExit(
      dispatchCommand({ kind: "aws", action: "permissions" }, env).pipe(Effect.provide(layer2)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(terminal2.state.stdout.join("")).toContain("pre-existing");
  });
});
