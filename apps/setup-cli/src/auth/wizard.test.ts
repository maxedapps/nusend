import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { AwsAuthError } from "../errors.ts";
import { TerminalFake } from "../terminal.ts";
import { AwsCliFake, type AwsCliService, type ResolvedCallerContext } from "./aws-cli.ts";
import type { ModernSsoProfile } from "./profile.ts";
import {
  buildVerifiedBinding,
  configureSsoArgv,
  ensureFreshSession,
  runAwsAuthWizard,
  ssoLoginArgv,
} from "./wizard.ts";

const profile: ModernSsoProfile = {
  profileName: "nusend-demo",
  ssoSessionName: "nusend-demo-sso",
  accountId: "123456789012",
  roleName: "NusendProvisioner",
  identityCenterRegion: "us-east-1",
  profileRegion: "eu-west-1",
};

// `ensureFreshSession` still takes a terminal for its log lines; prompts now come
// from the Terminal service in context.
const logOnly = {
  writeOut: () => Effect.succeed(undefined),
  writeErr: () => Effect.succeed(undefined),
  promptLine: () => Effect.succeed(""),
  promptSecret: () => Effect.succeed(""),
} as never;

const caller: ResolvedCallerContext = {
  accountId: "123456789012",
  arn: "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_NusendProvisioner_ab12/user",
  partition: "aws",
  roleName: "NusendProvisioner",
  userId: "AROA:user",
};

function profileConfigGet(key: string, p: ModernSsoProfile = profile): string | null {
  const map: Record<string, string> = {
    sso_session: p.ssoSessionName,
    sso_account_id: p.accountId,
    sso_role_name: p.roleName,
    region: p.profileRegion ?? "",
  };
  return map[key] ?? null;
}

function baseAws(overrides: Partial<AwsCliService> = {}): Layer.Layer<AwsCliService> {
  return AwsCliFake({
    listProfiles: () => Effect.succeed(["nusend-demo"]),
    configureGet: (_profileName, key) => Effect.succeed(profileConfigGet(key)),
    configureGetSsoSession: () => Effect.succeed("us-east-1"),
    configureList: () => Effect.succeed("access_key : **** : sso :\nsecret_key : **** : sso :\n"),
    getCallerIdentity: () => Effect.succeed(caller),
    verifyProfileSession: () => Effect.succeed(caller),
    runInheritedSso: () =>
      Effect.succeed({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        argv: ["aws"],
      }),
    awsVersionText: () => Effect.succeed("aws-cli/2.22.0 Python/3.12"),
    runCaptured: () =>
      Effect.succeed({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        argv: ["aws"],
      }),
    ...overrides,
  });
}

describe("auth wizard flows", () => {
  it("configure-sso argv: browser PKCE vs device-code", () => {
    expect(configureSsoArgv("p", "browser")).toEqual(["configure", "sso", "--profile", "p"]);
    expect(configureSsoArgv("p", "device-code")).toEqual([
      "configure",
      "sso",
      "--profile",
      "p",
      "--use-device-code",
      "--no-browser",
    ]);
    expect(ssoLoginArgv("p")).toEqual(["sso", "login", "--profile", "p"]);
  });

  it("no profiles → configure flow with device code", async () => {
    const inherited: string[][] = [];
    const terminal = TerminalFake();
    const aws = baseAws({
      listProfiles: () => Effect.succeed([]),
      runInheritedSso: (args) => {
        inherited.push([...args]);
        return Effect.succeed({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          argv: ["aws", ...args],
        });
      },
    });

    const binding = await Effect.runPromise(
      runAwsAuthWizard(
        {
          workloadRegion: "eu-west-1",
          expectedAccountId: "123456789012",
          installationId: "demo",
        },
        { preferDeviceCode: true },
      ).pipe(Effect.provide(Layer.mergeAll(aws, terminal.layer))),
    );

    expect(binding.awsAuth.profileName).toBe("nusend-demo");
    expect(inherited[0]).toEqual([
      "configure",
      "sso",
      "--profile",
      "nusend-demo",
      "--use-device-code",
      "--no-browser",
    ]);
  });

  it("multiple assigned profile choices", async () => {
    const other: ModernSsoProfile = {
      ...profile,
      profileName: "other",
      ssoSessionName: "other-sso",
    };
    const terminal = TerminalFake({ answers: ["2"] });
    const aws = baseAws({
      listProfiles: () => Effect.succeed(["nusend-demo", "other"]),
      configureGet: (name, key) =>
        Effect.succeed(profileConfigGet(key, name === "other" ? other : profile)),
    });

    const binding = await Effect.runPromise(
      runAwsAuthWizard({
        workloadRegion: "eu-west-1",
        expectedAccountId: "123456789012",
      }).pipe(Effect.provide(Layer.mergeAll(aws, terminal.layer))),
    );
    expect(binding.profile.profileName).toBe("other");
  });

  it("configure-another choice launches configure sso (browser)", async () => {
    const inherited: string[][] = [];
    const terminal = TerminalFake({ answers: ["2", "n"] });
    const aws = baseAws({
      listProfiles: () => Effect.succeed(["nusend-demo"]),
      runInheritedSso: (args) => {
        inherited.push([...args]);
        return Effect.succeed({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          argv: ["aws", ...args],
        });
      },
    });

    await Effect.runPromise(
      runAwsAuthWizard({
        workloadRegion: "eu-west-1",
        expectedAccountId: "123456789012",
        installationId: "demo",
      }).pipe(Effect.provide(Layer.mergeAll(aws, terminal.layer))),
    );
    expect(inherited[0]?.slice(0, 3)).toEqual(["configure", "sso", "--profile"]);
    expect(inherited[0]).not.toContain("--use-device-code");
  });

  it("re-prompts an out-of-range profile number instead of aborting", async () => {
    const terminal = TerminalFake({ answers: ["banana", "9", "1"] });
    const aws = baseAws({});

    const binding = await Effect.runPromise(
      runAwsAuthWizard({
        workloadRegion: "eu-west-1",
        expectedAccountId: "123456789012",
      }).pipe(Effect.provide(Layer.mergeAll(aws, terminal.layer))),
    );

    expect(binding.caller.accountId).toBe("123456789012");
    expect(terminal.state.prompts.filter((p) => p.includes("Choose profile"))).toHaveLength(3);
  });

  it("existing valid session succeeds without login", async () => {
    const inherited: string[][] = [];
    const terminal = TerminalFake({ answers: ["1"] });
    const aws = baseAws({
      runInheritedSso: (args) => {
        inherited.push([...args]);
        return Effect.succeed({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          argv: ["aws", ...args],
        });
      },
    });

    const binding = await Effect.runPromise(
      runAwsAuthWizard({
        workloadRegion: "eu-west-1",
        expectedAccountId: "123456789012",
      }).pipe(Effect.provide(Layer.mergeAll(aws, terminal.layer))),
    );
    expect(binding.caller.accountId).toBe("123456789012");
    expect(inherited).toEqual([]);
  });

  it("expired → one login → success", async () => {
    let verifyCount = 0;
    const inherited: string[][] = [];
    const aws = {
      verifyProfileSession: () => {
        verifyCount += 1;
        if (verifyCount === 1) {
          return Effect.fail(new AwsAuthError({ message: "expired", reason: "expired-session" }));
        }
        return Effect.succeed(caller);
      },
      runInheritedSso: (args: readonly string[]) => {
        inherited.push([...args]);
        return Effect.succeed({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          argv: ["aws", ...args],
        });
      },
    };

    const terminal = TerminalFake({ answers: ["y"] });
    const out = await Effect.runPromise(
      ensureFreshSession(aws as never, logOnly, profile, "eu-west-1").pipe(
        Effect.provide(terminal.layer),
      ),
    );

    expect(out.accountId).toBe("123456789012");
    expect(verifyCount).toBe(2);
    expect(inherited[0]).toEqual(["sso", "login", "--profile", "nusend-demo"]);
  });

  it("login cancellation stops without retry loop", async () => {
    let verifyCount = 0;
    const aws = {
      verifyProfileSession: () => {
        verifyCount += 1;
        return Effect.fail(new AwsAuthError({ message: "expired", reason: "expired-session" }));
      },
      runInheritedSso: () =>
        Effect.fail(new AwsAuthError({ message: "cancelled", reason: "login-cancelled" })),
    };
    const terminal = TerminalFake({ answers: ["y"] });

    const exit = await Effect.runPromiseExit(
      ensureFreshSession(aws as never, logOnly, profile, "eu-west-1").pipe(
        Effect.provide(terminal.layer),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(verifyCount).toBe(1);
  });

  it("declining login is cancellation", async () => {
    const aws = {
      verifyProfileSession: () =>
        Effect.fail(new AwsAuthError({ message: "expired", reason: "expired-session" })),
      runInheritedSso: () =>
        Effect.succeed({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          argv: ["aws"],
        }),
    };
    const terminal = TerminalFake({ answers: ["n"] });
    const exit = await Effect.runPromiseExit(
      ensureFreshSession(aws as never, logOnly, profile, "eu-west-1").pipe(
        Effect.provide(terminal.layer),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("wrong account/role/partition fail binding", async () => {
    const base = await Effect.runPromise(
      buildVerifiedBinding(profile, caller, {
        workloadRegion: "eu-west-1",
        expectedAccountId: "123456789012",
      }),
    );
    expect(base.awsAuth.verifiedAccountId).toBe("123456789012");

    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          buildVerifiedBinding(
            profile,
            { ...caller, accountId: "999999999999" },
            { workloadRegion: "eu-west-1", expectedAccountId: "123456789012" },
          ),
        ),
      ),
    ).toBe(true);

    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          buildVerifiedBinding(
            profile,
            { ...caller, roleName: "OtherRole" },
            {
              workloadRegion: "eu-west-1",
            },
          ),
        ),
      ),
    ).toBe(true);

    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          buildVerifiedBinding(
            profile,
            { ...caller, partition: "aws-us-gov" },
            {
              workloadRegion: "eu-west-1",
              expectedPartition: "aws",
            },
          ),
        ),
      ),
    ).toBe(true);
  });

  it("profile mutation against expected role is rejected", async () => {
    const exit = await Effect.runPromiseExit(
      buildVerifiedBinding(profile, caller, {
        workloadRegion: "eu-west-1",
        expectedRoleName: "DifferentRole",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fake inherited processes expose no captured stdout/stderr and snapshots stay clean", async () => {
    let verifyCount = 0;
    const terminal = TerminalFake({ answers: ["1", "y"] });
    const aws = baseAws({
      verifyProfileSession: () => {
        verifyCount += 1;
        if (verifyCount === 1) {
          return Effect.fail(new AwsAuthError({ message: "expired", reason: "expired-session" }));
        }
        return Effect.succeed(caller);
      },
      runInheritedSso: (args) =>
        Effect.succeed({
          exitCode: 0,
          signal: null,
          // ProcessRunner inherited mode contract
          stdout: "",
          stderr: "",
          argv: ["aws", ...args],
        }),
    });

    const binding = await Effect.runPromise(
      runAwsAuthWizard({
        workloadRegion: "eu-west-1",
        expectedAccountId: "123456789012",
      }).pipe(Effect.provide(Layer.mergeAll(aws, terminal.layer))),
    );

    const snapshot = JSON.stringify({
      auth: binding.awsAuth,
      stdout: terminal.state.stdout,
      stderr: terminal.state.stderr,
    });
    expect(snapshot).not.toMatch(/device-code|https:\/\/|AKIA|ASIA|sessiontoken|accessToken/i);
    expect(binding.awsAuth).not.toHaveProperty("accessToken");
  });
});
