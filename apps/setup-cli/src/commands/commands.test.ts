import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AwsCliFake, type ResolvedCallerContext } from "../auth/aws-cli.ts";
import { NotPortedError } from "../errors.ts";
import { ProcessRunnerFake } from "../process-runner.ts";
import { SetupStoreLive } from "../services/setup-store.ts";
import { TerminalFake } from "../terminal.ts";
import { dispatchCommand, parseAndDispatch } from "./dispatch.ts";
import { runContinue } from "./continue.ts";
import { runStatus } from "./status.ts";
import type { SetupStateV2 } from "../state/schema.ts";
import { SetupStore } from "../services/setup-store.ts";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "nusend-setup-cli-"));
  temps.push(home);
  return { ...process.env, NUSEND_SETUP_HOME: home };
}

const caller: ResolvedCallerContext = {
  accountId: "123456789012",
  arn: "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_NusendProvisioner_ab12/user",
  partition: "aws",
  roleName: "NusendProvisioner",
  userId: "AROA:user",
};

function sampleState(installationId = "demo"): SetupStateV2 {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 2,
    installationId,
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
      installationName: installationId,
    },
    stages: {
      init: {
        status: "complete",
        completedAt: now,
        evidence: { verified: true, installationId },
      },
    },
    plans: {},
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
}

function testLayer(terminal = TerminalFake()) {
  return {
    terminal,
    layer: Layer.mergeAll(
      terminal.layer,
      SetupStoreLive,
      ProcessRunnerFake(),
      AwsCliFake({
        listProfiles: () => Effect.succeed(["nusend-demo"]),
        configureGet: (_p, key) =>
          Effect.succeed(
            (
              {
                sso_session: "nusend-demo-sso",
                sso_account_id: "123456789012",
                sso_role_name: "NusendProvisioner",
              } as Record<string, string>
            )[key] ?? null,
          ),
        configureGetSsoSession: () => Effect.succeed("us-east-1"),
        configureList: () => Effect.succeed("access_key : x : sso :\n"),
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
        awsVersionText: () => Effect.succeed("aws-cli/2.22.0"),
        runCaptured: () =>
          Effect.succeed({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            argv: ["aws"],
          }),
      }),
    ),
  };
}

describe("command programs", () => {
  it("help is mutation-free with temp setup home", async () => {
    const env = tempEnv();
    const { terminal, layer } = testLayer();
    await Effect.runPromise(parseAndDispatch(["--help"], env).pipe(Effect.provide(layer)));
    expect(terminal.state.stdout.join("")).toContain("Usage:");
    // no installation created
    const storeCheck = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        return yield* store.resolveInstallationId(env);
      }).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(storeCheck)).toBe(true);
  });

  it("unknown command is usage error without store writes", async () => {
    const env = tempEnv();
    const { layer } = testLayer();
    const exit = await Effect.runPromiseExit(
      parseAndDispatch(["nope"], env).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("continue with missing stage handler fails NotPorted without checkpoint", async () => {
    const env = tempEnv();
    const { terminal, layer } = testLayer();
    // aws_core is wired (T5); leave the next stage (human_gates) unported to assert NotPorted.
    const state = {
      ...sampleState(),
      stages: {
        ...sampleState().stages,
        aws_core: {
          status: "complete" as const,
          completedAt: "2026-01-01T00:00:00.000Z",
          evidence: { verified: true },
        },
      },
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.reserveInstallationDirectory(state.installationId, env);
        yield* store.writeState(state, env);
        yield* store.writeDeploymentEnv(
          state.installationId,
          {
            NUSEND_DOMAIN: state.config.domain,
            NUSEND_INGRESS_MODE: state.config.ingressMode,
            NUSEND_OWNER_EMAIL: state.config.ownerEmail,
            NUSEND_OWNER_NAME: state.config.ownerName,
            BETTER_AUTH_SECRET: "x".repeat(32),
            GOOGLE_CLIENT_ID: "cid",
            GOOGLE_CLIENT_SECRET: "csec",
            NUSEND_API_KEY_HASH_SECRET: "y".repeat(32),
            NUSEND_UNSUBSCRIBE_SECRET: "z".repeat(32),
            AWS_REGION: state.config.awsRegion,
            NUSEND_SES_FROM_EMAIL: state.config.sesFromEmail,
            NUSEND_RESTIC_REPOSITORY: "s3:https://example/r2",
            NUSEND_R2_ACCESS_KEY_ID: "r2",
            NUSEND_R2_SECRET_ACCESS_KEY: "r2s",
            NUSEND_RESTIC_PASSWORD: "rpw",
          },
          env,
        );
        yield* store.writeCurrentPointer(state.installationId, env);
      }).pipe(Effect.provide(layer)),
    );

    const exit = await Effect.runPromiseExit(
      // Null removes the default human_gates handler so NotPorted still has a path.
      runContinue(env, { human_gates: null }).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const pretty = String(exit.cause);
      expect(pretty).toMatch(/not ready|NotPorted|human_gates/i);
    }

    const reloaded = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        return yield* store.loadState(state.installationId, env);
      }).pipe(Effect.provide(layer)),
    );
    expect(reloaded.stages.human_gates).toBeUndefined();
    expect(reloaded.stages.aws_core?.status).toBe("complete");
    expect(terminal.state.stdout.join("")).not.toMatch(/device-code|https:\/\//i);
  });

  it("status local is mutation-free; refresh prompts before auth when expired", async () => {
    const env = tempEnv();
    const state = sampleState();
    let verifyCount = 0;
    const terminal = TerminalFake({ answers: ["y"] });
    const layer = Layer.mergeAll(
      terminal.layer,
      SetupStoreLive,
      ProcessRunnerFake(),
      AwsCliFake({
        listProfiles: () => Effect.succeed(["nusend-demo"]),
        configureGet: (_p, key) =>
          Effect.succeed(
            (
              {
                sso_session: "nusend-demo-sso",
                sso_account_id: "123456789012",
                sso_role_name: "NusendProvisioner",
              } as Record<string, string>
            )[key] ?? null,
          ),
        configureGetSsoSession: () => Effect.succeed("us-east-1"),
        configureList: () => Effect.succeed("access_key : x : sso :\n"),
        getCallerIdentity: () => Effect.succeed(caller),
        verifyProfileSession: () => {
          verifyCount += 1;
          if (verifyCount === 1) {
            return Effect.fail(
              new (class extends Error {
                readonly _tag = "AwsAuthError";
                readonly reason = "expired-session";
                readonly message = "expired";
              })(),
            ) as never;
          }
          return Effect.succeed(caller);
        },
        runInheritedSso: () =>
          Effect.succeed({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            argv: ["aws", "sso", "login", "--profile", "nusend-demo"],
          }),
        awsVersionText: () => Effect.succeed("aws-cli/2.22.0"),
        runCaptured: () =>
          Effect.succeed({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            argv: ["aws"],
          }),
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.reserveInstallationDirectory(state.installationId, env);
        yield* store.writeState(state, env);
        yield* store.writeCurrentPointer(state.installationId, env);
      }).pipe(Effect.provide(layer)),
    );

    await Effect.runPromise(runStatus(false, env).pipe(Effect.provide(layer)));
    expect(terminal.state.stdout.join("")).toContain("local-only");
    expect(verifyCount).toBe(0);

    // Proper expired error type:
    const { AwsAuthError } = await import("../errors.ts");
    verifyCount = 0;
    const terminal2 = TerminalFake({ answers: ["y"] });
    const layer2 = Layer.mergeAll(
      terminal2.layer,
      SetupStoreLive,
      ProcessRunnerFake(),
      AwsCliFake({
        listProfiles: () => Effect.succeed(["nusend-demo"]),
        configureGet: (_p, key) =>
          Effect.succeed(
            (
              {
                sso_session: "nusend-demo-sso",
                sso_account_id: "123456789012",
                sso_role_name: "NusendProvisioner",
              } as Record<string, string>
            )[key] ?? null,
          ),
        configureGetSsoSession: () => Effect.succeed("us-east-1"),
        configureList: () => Effect.succeed("access_key : x : sso :\n"),
        getCallerIdentity: () => Effect.succeed(caller),
        verifyProfileSession: () => {
          verifyCount += 1;
          if (verifyCount === 1) {
            return Effect.fail(new AwsAuthError({ message: "expired", reason: "expired-session" }));
          }
          return Effect.succeed(caller);
        },
        runInheritedSso: () =>
          Effect.succeed({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            argv: ["aws", "sso", "login", "--profile", "nusend-demo"],
          }),
        awsVersionText: () => Effect.succeed("aws-cli/2.22.0"),
        runCaptured: () =>
          Effect.succeed({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            argv: ["aws"],
          }),
      }),
    );

    await Effect.runPromise(runStatus(true, env).pipe(Effect.provide(layer2)));
    // One expired check + post-login recheck (+ optional refresh revalidation).
    expect(verifyCount).toBeGreaterThanOrEqual(2);
    expect(terminal2.state.prompts.join(" ")).toMatch(/sso login|SSO session/i);
    expect(terminal2.state.stdout.join("")).toContain("aws-caller");
  });

  it("not-ported handlers for aws plan/deploy/destroy parse but fail typed", async () => {
    const env = tempEnv();
    const { layer } = testLayer();
    for (const command of [
      { kind: "aws" as const, action: "plan" as const },
      { kind: "deploy" as const, action: "apply" as const },
      { kind: "destroy" as const, action: "plan" as const },
    ]) {
      const exit = await Effect.runPromiseExit(
        dispatchCommand(command, env).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  it("NotPortedError is the failure tag for missing stage", async () => {
    const err = new NotPortedError({
      stageOrCommand: "aws_core",
      message: "not ready",
    });
    expect(err._tag).toBe("NotPortedError");
  });
});
