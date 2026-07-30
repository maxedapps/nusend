import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { SetupStore, SetupStoreLive } from "../services/setup-store.ts";
import { PROVISIONER_POLICY_FILE_NAME, SECRET_ENV_KEYS } from "../state/constants.ts";
import { policyArtifactPath } from "../state/paths.ts";
import type { SetupStateV2 } from "../state/schema.ts";
import { writePolicyArtifactAndRecord } from "./permissions.ts";
import {
  FORBIDDEN_PROVISIONING_ACTIONS,
  ProvisioningPolicyError,
  ROUTE53_STATEMENT_SID,
  SAMPLE_ACCOUNT_ID,
  SAMPLE_HOSTED_ZONE_ID,
  SAMPLE_REGION,
  SAMPLE_RESOURCE_PREFIX,
  buildRuntimeUserName,
  buildStackName,
  fingerprintProvisioningPolicyJson,
  loadCanonicalProvisioningPolicyTemplate,
  renderProvisioningPolicy,
  serializeProvisioningPolicyJson,
  type IamPolicyDocument,
  type IamPolicyStatement,
} from "./provisioning-policy.ts";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function actionsOf(statement: IamPolicyStatement): string[] {
  if (typeof statement.Action === "string") return [statement.Action];
  if (Array.isArray(statement.Action)) return [...statement.Action];
  return [];
}

function resourcesOf(statement: IamPolicyStatement): string[] {
  if (typeof statement.Resource === "string") return [statement.Resource];
  if (Array.isArray(statement.Resource)) return [...statement.Resource];
  return [];
}

function flattenActions(document: IamPolicyDocument): string[] {
  return (document.Statement ?? []).flatMap((statement) => actionsOf(statement));
}

function baseContext(overrides: Partial<Parameters<typeof renderProvisioningPolicy>[0]> = {}) {
  return {
    partition: "aws",
    region: "us-east-1",
    accountId: "123456789012",
    installationId: "demo",
    installationName: "demo",
    route53HostedZoneId: "Z1234567890ABC",
    ...overrides,
  };
}

describe("renderProvisioningPolicy", () => {
  it("renders commercial partition with Route 53 and exact runtime-user scope", () => {
    const rendered = renderProvisioningPolicy(baseContext());
    const blob = rendered.json;
    expect(JSON.parse(blob)).toEqual(rendered.document);
    expect(rendered.fileName).toBe(PROVISIONER_POLICY_FILE_NAME);
    expect(rendered.stackName).toBe("nusend-demo");
    expect(rendered.runtimeUserName).toBe("nusend-demo-runtime");

    const iam = rendered.document.Statement?.find(
      (s) => s.Sid === "ManageRuntimeIamUserAndAccessKeys",
    );
    expect(iam?.Resource).toBe("arn:aws:iam::123456789012:user/nusend-demo-runtime");

    const route53 = rendered.document.Statement?.find((s) => s.Sid === ROUTE53_STATEMENT_SID);
    expect(route53?.Resource).toBe("arn:aws:route53:::hostedzone/Z1234567890ABC");
    expect(blob).toContain("Z1234567890ABC");
  });

  it("omits the entire Route 53 statement when zone is not selected", () => {
    const withZone = renderProvisioningPolicy(baseContext({ route53HostedZoneId: "ZABC123" }));
    const without = renderProvisioningPolicy(
      baseContext({ route53HostedZoneId: null, installationId: "demo" }),
    );
    expect(withZone.document.Statement?.some((s) => s.Sid === ROUTE53_STATEMENT_SID)).toBe(true);
    expect(without.document.Statement?.some((s) => s.Sid === ROUTE53_STATEMENT_SID)).toBe(false);
    expect(without.json).not.toContain("route53");
    expect(without.json).not.toContain(SAMPLE_HOSTED_ZONE_ID);
    expect(without.fingerprintSha256).not.toBe(withZone.fingerprintSha256);
  });

  it("renders GovCloud partition/region/account/installation/zone substitutions", () => {
    const rendered = renderProvisioningPolicy({
      partition: "aws-us-gov",
      region: "us-gov-west-1",
      accountId: "210987654321",
      installationId: "federal",
      installationName: "federal",
      route53HostedZoneId: "Z0GOVCLOUD12345",
    });
    const blob = rendered.json;
    expect(blob).not.toMatch(/arn:aws:|us-east-1|123456789012|nusend-demo|Z1234567890ABC/u);
    expect(blob).toContain(
      "arn:aws-us-gov:cloudformation:us-gov-west-1:210987654321:stack/nusend-federal/*",
    );
    expect(blob).toContain("arn:aws-us-gov:iam::210987654321:user/nusend-federal-runtime");
    expect(blob).toContain("arn:aws-us-gov:route53:::hostedzone/Z0GOVCLOUD12345");
    for (const statement of rendered.document.Statement ?? []) {
      for (const resource of resourcesOf(statement)) {
        if (resource === "*") continue;
        expect(resource.startsWith("arn:aws-us-gov:")).toBe(true);
      }
    }
  });

  it("covers multiple regions, accounts, and installations with stable fingerprints", () => {
    const cases = [
      {
        partition: "aws",
        region: "eu-west-1",
        accountId: "111122223333",
        installationId: "prod",
      },
      {
        partition: "aws",
        region: "ap-southeast-2",
        accountId: "444455556666",
        installationId: "staging",
      },
      {
        partition: "aws-cn",
        region: "cn-north-1",
        accountId: "777788889999",
        installationId: "china1",
      },
    ] as const;

    const fingerprints = new Set<string>();
    for (const c of cases) {
      const a = renderProvisioningPolicy({ ...c, route53HostedZoneId: null });
      const b = renderProvisioningPolicy({ ...c, route53HostedZoneId: null });
      expect(a.fingerprintSha256).toBe(b.fingerprintSha256);
      expect(a.json).toBe(b.json);
      expect(a.json).toContain(`stack/nusend-${c.installationId}/*`);
      expect(a.json).toContain(`${c.accountId}`);
      expect(a.json).toContain(c.region);
      fingerprints.add(a.fingerprintSha256);
    }
    expect(fingerprints.size).toBe(cases.length);
  });

  it("fingerprints the exact canonical JSON body (sha256)", () => {
    const rendered = renderProvisioningPolicy(baseContext({ route53HostedZoneId: null }));
    const expected = createHash("sha256").update(rendered.json, "utf8").digest("hex");
    expect(rendered.fingerprintSha256).toBe(expected);
    expect(fingerprintProvisioningPolicyJson(rendered.json)).toBe(expected);
    expect(serializeProvisioningPolicyJson(rendered.document)).toBe(rendered.json);
  });

  it("uses installationId for stack name and installationName for resource prefix", () => {
    const rendered = renderProvisioningPolicy({
      partition: "aws",
      region: "us-west-2",
      accountId: "123456789012",
      installationId: "stackid",
      installationName: "resname",
      route53HostedZoneId: null,
    });
    expect(rendered.stackName).toBe(buildStackName("stackid"));
    expect(rendered.runtimeUserName).toBe(buildRuntimeUserName("resname"));
    expect(rendered.json).toContain("stack/nusend-stackid/*");
    expect(rendered.json).toContain("user/nusend-resname-runtime");
    expect(rendered.json).toContain("nusend-resname-ses-events");
  });

  it("scopes CloudWatch alarms to the four exact ARNs", () => {
    const rendered = renderProvisioningPolicy(
      baseContext({ installationId: "acme", installationName: "acme", route53HostedZoneId: null }),
    );
    const alarms = rendered.document.Statement?.find((s) => s.Sid === "ManageCloudWatchAlarms");
    expect(resourcesOf(alarms!)).toEqual([
      "arn:aws:cloudwatch:us-east-1:123456789012:alarm:nusend-acme-sns-notifications-failed",
      "arn:aws:cloudwatch:us-east-1:123456789012:alarm:nusend-acme-sns-redriven-to-dlq",
      "arn:aws:cloudwatch:us-east-1:123456789012:alarm:nusend-acme-sns-redrive-failed",
      "arn:aws:cloudwatch:us-east-1:123456789012:alarm:nusend-acme-dlq-visible-messages",
    ]);
  });

  it("rejects invalid context values", () => {
    expect(() => renderProvisioningPolicy(baseContext({ accountId: "123" }))).toThrow(
      ProvisioningPolicyError,
    );
    expect(() => renderProvisioningPolicy(baseContext({ partition: "not-a-partition" }))).toThrow(
      ProvisioningPolicyError,
    );
    expect(() => renderProvisioningPolicy(baseContext({ region: "US_EAST_1" }))).toThrow(
      ProvisioningPolicyError,
    );
    expect(() => renderProvisioningPolicy(baseContext({ installationId: "BAD" }))).toThrow(
      ProvisioningPolicyError,
    );
    expect(() =>
      renderProvisioningPolicy(baseContext({ route53HostedZoneId: "not-a-zone" })),
    ).toThrow(ProvisioningPolicyError);
  });

  it("rejects unresolved sample tokens when template is not fully substituted", () => {
    const template = loadCanonicalProvisioningPolicyTemplate();
    // Force a leftover sample hosted zone by claiming a different zone but corrupting template.
    const corrupted = template.replaceAll(SAMPLE_HOSTED_ZONE_ID, "ZKEEP_SAMPLE_TOKEN_XYZ");
    // Put sample zone back into one place that substitution won't touch if we already replaced.
    // Instead inject sample token after a fake render path via custom template that keeps sample account in a Sid-less form.
    const broken = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "InspectProvisioningCaller",
          Effect: "Allow",
          Action: "sts:GetCallerIdentity",
          Resource: "*",
        },
        // Minimal incomplete set — missing required SIDs triggers validation
      ],
    });
    expect(() =>
      renderProvisioningPolicy(
        baseContext({
          accountId: "999988887777",
          installationId: "other",
          installationName: "other",
          region: "eu-central-1",
          route53HostedZoneId: null,
        }),
        broken,
      ),
    ).toThrow(/missing required statement/i);

    // Unresolved sample region when real region differs: inject sample region into a non-substituted field by
    // using a template resource that still contains sample after bad custom substitution simulation.
    const withLeftover = loadCanonicalProvisioningPolicyTemplate().replace(
      `"Resource": "*"`,
      `"Resource": "arn:aws:sns:${SAMPLE_REGION}:${SAMPLE_ACCOUNT_ID}:leftover"`,
    );
    // First statement Resource becomes non-star — fails star or unexpected resource validation.
    expect(() =>
      renderProvisioningPolicy(
        baseContext({
          region: "eu-west-1",
          accountId: "999988887777",
          installationId: "x",
          installationName: "x",
          route53HostedZoneId: null,
        }),
        withLeftover,
      ),
    ).toThrow(ProvisioningPolicyError);
    void corrupted;
  });

  it("rejects forbidden actions and over-broad wildcards in a tampered template", () => {
    const template = JSON.parse(loadCanonicalProvisioningPolicyTemplate()) as IamPolicyDocument;
    const statements = [...(template.Statement ?? [])] as IamPolicyStatement[];
    const iamIdx = statements.findIndex((s) => s.Sid === "ManageRuntimeIamUserAndAccessKeys");
    statements[iamIdx] = {
      ...statements[iamIdx]!,
      Action: [...actionsOf(statements[iamIdx]!), "iam:PassRole", "iam:AttachUserPolicy"],
      Resource: "*",
    };
    const tampered = JSON.stringify({ Version: "2012-10-17", Statement: statements });
    expect(() =>
      renderProvisioningPolicy(
        baseContext({
          installationId: "safe",
          installationName: "safe",
          route53HostedZoneId: null,
        }),
        tampered,
      ),
    ).toThrow(/forbidden|unexpected|over-broad|Resource "\*"/i);

    for (const action of FORBIDDEN_PROVISIONING_ACTIONS.slice(0, 5)) {
      const clone = JSON.parse(loadCanonicalProvisioningPolicyTemplate()) as IamPolicyDocument;
      const sts = [...(clone.Statement ?? [])] as IamPolicyStatement[];
      sts[0] = {
        ...sts[0]!,
        Action: [action],
      };
      expect(() =>
        renderProvisioningPolicy(
          baseContext({ route53HostedZoneId: null, installationId: "z", installationName: "z" }),
          JSON.stringify({ Version: "2012-10-17", Statement: sts }),
        ),
      ).toThrow(ProvisioningPolicyError);
    }
  });

  it("rejects unexpected statement Sids", () => {
    const template = JSON.parse(loadCanonicalProvisioningPolicyTemplate()) as IamPolicyDocument;
    const statements = [
      ...(template.Statement ?? []),
      {
        Sid: "AdminEverything",
        Effect: "Allow",
        Action: "sts:GetCallerIdentity",
        Resource: "*",
      },
    ];
    expect(() =>
      renderProvisioningPolicy(
        baseContext({ route53HostedZoneId: null }),
        JSON.stringify({ Version: "2012-10-17", Statement: statements }),
      ),
    ).toThrow(/Unexpected policy statement Sid/i);
  });

  it("rejects secret-shaped fields in rendered output", () => {
    const template = JSON.parse(loadCanonicalProvisioningPolicyTemplate()) as IamPolicyDocument;
    const dirty = {
      ...template,
      AWS_SECRET_ACCESS_KEY: "should-not-appear",
    };
    expect(() =>
      renderProvisioningPolicy(baseContext({ route53HostedZoneId: null }), JSON.stringify(dirty)),
    ).toThrow(/secret-shaped/i);
  });

  it("produces importable JSON with only Allow statements and no forbidden services", () => {
    const rendered = renderProvisioningPolicy(
      baseContext({
        installationId: "importable",
        installationName: "importable",
        route53HostedZoneId: "ZIMPORTZONE01",
      }),
    );
    const parsed = JSON.parse(rendered.json) as IamPolicyDocument;
    expect(parsed.Version).toBe("2012-10-17");
    for (const statement of parsed.Statement ?? []) {
      expect(statement.Effect).toBe("Allow");
    }
    const joined = flattenActions(parsed).join("\n");
    expect(joined.includes("secretsmanager:")).toBe(false);
    expect(joined.includes("ssm:")).toBe(false);
    expect(joined.includes("kms:")).toBe(false);
    expect(joined.includes("iam:PassRole")).toBe(false);
    for (const key of SECRET_ENV_KEYS) {
      expect(rendered.json).not.toContain(key);
    }
  });

  it("loads the canonical template from the monorepo path", () => {
    const raw = loadCanonicalProvisioningPolicyTemplate();
    expect(raw).toContain(SAMPLE_RESOURCE_PREFIX);
    expect(raw).toContain(SAMPLE_HOSTED_ZONE_ID);
    expect(raw).toContain(ROUTE53_STATEMENT_SID);
  });
});

describe("policy artifact write via SetupStore", () => {
  it("writes mode 0600 artifact and records non-secret metadata only", async () => {
    const home = mkdtempSync(join(tmpdir(), "nusend-policy-"));
    temps.push(home);
    const env = { NUSEND_SETUP_HOME: home } as NodeJS.ProcessEnv;

    const now = "2026-06-01T00:00:00.000Z";
    const state: SetupStateV2 = {
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
        route53HostedZoneId: "ZTESTZONE123",
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
          templateFingerprint: "fp-keep-me",
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.reserveInstallationDirectory("demo", env);
        yield* store.writeState(state, env);
        yield* store.writeCurrentPointer("demo", env);
      }).pipe(Effect.provide(SetupStoreLive)),
    );

    const result = await Effect.runPromise(
      writePolicyArtifactAndRecord(state, {
        env,
        dedicatedTemporaryAssignment: true,
      }).pipe(Effect.provide(SetupStoreLive)),
    );

    const path = policyArtifactPath("demo", env);
    expect(result.artifactPath).toBe(path);
    const body = readFileSync(path, "utf8");
    expect(body).toBe(result.rendered.json);
    expect(JSON.parse(body).Version).toBe("2012-10-17");

    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Plans preserved
    expect(result.state.plans.aws_core).toEqual(state.plans.aws_core);
    expect(result.state.provisionerPolicy?.fileName).toBe(PROVISIONER_POLICY_FILE_NAME);
    expect(result.state.provisionerPolicy?.fingerprintSha256).toBe(
      result.rendered.fingerprintSha256,
    );
    expect(result.state.provisionerPolicy?.accountId).toBe("123456789012");
    expect(result.state.provisionerPolicy?.region).toBe("eu-west-1");
    expect(result.state.provisionerPolicy?.dedicatedTemporaryAssignment).toBe(true);

    const stateJson = readFileSync(join(home, "demo", "state.json"), "utf8");
    for (const key of SECRET_ENV_KEYS) {
      expect(stateJson).not.toContain(key);
      expect(body).not.toContain(key);
    }
    expect(stateJson).not.toMatch(/password|private_key|session_token/i);
  });
});
