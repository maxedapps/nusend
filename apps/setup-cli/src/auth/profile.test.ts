import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  assertSsoProvenance,
  classifyModernSsoProfile,
  generateSsoNames,
  parseListProfiles,
} from "./profile.ts";

describe("modern SSO profile classification", () => {
  it("accepts modern sso_session profiles", async () => {
    const profile = await Effect.runPromise(
      classifyModernSsoProfile(
        "nusend-dev",
        {
          sso_session: "nusend-dev-sso",
          sso_account_id: "123456789012",
          sso_role_name: "NusendProvisioner",
          region: "eu-west-1",
        },
        "us-east-1",
      ),
    );
    expect(profile).toEqual({
      profileName: "nusend-dev",
      ssoSessionName: "nusend-dev-sso",
      accountId: "123456789012",
      roleName: "NusendProvisioner",
      identityCenterRegion: "us-east-1",
      profileRegion: "eu-west-1",
    });
  });

  it("rejects legacy sso_start_url-only profiles", async () => {
    const exit = await Effect.runPromiseExit(
      classifyModernSsoProfile(
        "legacy",
        {
          sso_start_url: "https://example.awsapps.com/start",
          sso_account_id: "123456789012",
          sso_role_name: "Admin",
          sso_region: "us-east-1",
        },
        null,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects static credentials, login_session, role chains, and credential_process", async () => {
    const cases = [
      { aws_access_key_id: "AKIA" },
      { login_session: "login" },
      { role_arn: "arn:aws:iam::1:role/x", source_profile: "base" },
      { credential_process: "vault aws" },
      { credential_source: "Environment" },
      { web_identity_token_file: "/tmp/t" },
    ] as const;

    for (const config of cases) {
      const exit = await Effect.runPromiseExit(
        classifyModernSsoProfile("bad", { ...config }, null),
      );
      expect(Exit.isFailure(exit), JSON.stringify(config)).toBe(true);
    }
  });

  it("parses list-profiles output", () => {
    expect(parseListProfiles("a\nb\n\n#c\n")).toEqual(["a", "b"]);
  });

  it("generates conservative profile/session names", () => {
    const names = generateSsoNames("Prod-Mail_01");
    expect(names.profileName).toMatch(/^nusend-/);
    expect(names.sessionHint).toMatch(/-sso$/);
  });
});

describe("SSO provenance allowlist", () => {
  it("accepts configure list output with sso type", async () => {
    const text = `
NAME       : VALUE                    : TYPE             : LOCATION
profile    : nusend-dev               : manual           : --profile
access_key : ********                 : sso              :
secret_key : ********                 : sso              :
region     : eu-west-1                : config-file      : ~/.aws/config
`;
    await Effect.runPromise(assertSsoProvenance("nusend-dev", text));
  });

  it("rejects env/shared-credentials/IMDS provenance", async () => {
    const bad = [
      "access_key : **** : env :",
      "access_key : **** : shared-credentials-file :",
      "access_key : **** : imds :",
      "access_key : **** : assume-role :",
      "access_key : **** : credential-process :",
      "access_key : **** : web-identity :",
      "access_key : **** : login :",
    ];
    for (const line of bad) {
      const exit = await Effect.runPromiseExit(assertSsoProvenance("p", line));
      expect(Exit.isFailure(exit), line).toBe(true);
    }
  });
});
