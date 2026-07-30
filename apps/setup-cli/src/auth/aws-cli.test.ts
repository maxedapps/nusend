import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ProcessFailedError, ProcessStartError } from "../errors.ts";
import { ProcessRunnerFake } from "../process-runner.ts";
import { AwsCli, AwsCliLiveWithEnv, isAwsCliV2_22OrNewer, parseAwsCliVersion } from "./aws-cli.ts";
import { buildSanitizedAwsEnv } from "./sanitized-env.ts";

describe("AwsCli thin helper", () => {
  it("parses and gates AWS CLI v2.22+", () => {
    expect(parseAwsCliVersion("aws-cli/2.22.0 Python/3.12.0")).toEqual({
      major: 2,
      minor: 22,
      patch: 0,
    });
    expect(isAwsCliV2_22OrNewer("aws-cli/2.22.0")).toBe(true);
    expect(isAwsCliV2_22OrNewer("aws-cli/2.21.9")).toBe(false);
    expect(isAwsCliV2_22OrNewer("aws-cli/1.32.0")).toBe(false);
  });

  it("runs discovery commands with sanitized env (denylist + forced flags)", async () => {
    const seenEnv: Array<Record<string, string | undefined>> = [];
    const runner = ProcessRunnerFake({
      runCaptured: (options) =>
        Effect.sync(() => {
          seenEnv.push({ ...(options.env as Record<string, string | undefined>) });
          if (options.args?.[0] === "configure" && options.args[1] === "list-profiles") {
            return {
              exitCode: 0,
              signal: null,
              stdout: "demo\n",
              stderr: "",
              argv: ["aws", ...(options.args ?? [])],
            };
          }
          return {
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            argv: ["aws", ...(options.args ?? [])],
          };
        }),
    });

    const parent = {
      PATH: "/bin",
      AWS_PROFILE: "ambient",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_ENDPOINT_URL: "https://evil.example",
      AWS_ENDPOINT_URL_STS: "https://sts.evil",
      AWS_CONFIG_FILE: "/tmp/config",
    };

    const profiles = await Effect.runPromise(
      Effect.gen(function* () {
        const aws = yield* AwsCli;
        return yield* aws.listProfiles();
      }).pipe(Effect.provide(AwsCliLiveWithEnv(parent).pipe(Layer.provide(runner)))),
    );

    expect(profiles).toEqual(["demo"]);
    expect(seenEnv.length).toBeGreaterThan(0);
    const env = seenEnv[0] ?? {};
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL_STS).toBeUndefined();
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe("/dev/null");
    expect(env.AWS_EC2_METADATA_DISABLED).toBe("true");
    expect(env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe("true");
    expect(env.AWS_CONFIG_FILE).toBe("/tmp/config");
    expect(env).toMatchObject(buildSanitizedAwsEnv(parent));
  });

  it("maps expired SSO process failures and rejects malformed STS JSON", async () => {
    const runner = ProcessRunnerFake({
      runCaptured: (options) => {
        const args = options.args ?? [];
        if (args.includes("get-caller-identity")) {
          if (args.includes("malformed")) {
            return Effect.succeed({
              exitCode: 0,
              signal: null,
              stdout: "{bad",
              stderr: "",
              argv: ["aws", ...args],
            });
          }
          return Effect.fail(
            new ProcessFailedError({
              exitCode: 255,
              argv: ["aws", ...args],
              stdout: "",
              stderr: "Error when retrieving token from sso: Token has expired and refresh failed",
              message: "expired",
            }),
          );
        }
        if (args[0] === "configure" && args[1] === "list") {
          return Effect.succeed({
            exitCode: 0,
            signal: null,
            stdout: "access_key : x : sso :\n",
            stderr: "",
            argv: ["aws", ...args],
          });
        }
        return Effect.fail(
          new ProcessStartError({
            argv: ["aws", ...args],
            message: "unexpected",
            cause: undefined,
          }),
        );
      },
    });

    const expired = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const aws = yield* AwsCli;
        return yield* aws.getCallerIdentity("demo", "eu-west-1");
      }).pipe(Effect.provide(AwsCliLiveWithEnv({}).pipe(Layer.provide(runner)))),
    );
    expect(Exit.isFailure(expired)).toBe(true);

    const malformedRunner = ProcessRunnerFake({
      runCaptured: (options) =>
        Effect.succeed({
          exitCode: 0,
          signal: null,
          stdout: "{bad",
          stderr: "",
          argv: ["aws", ...(options.args ?? [])],
        }),
    });
    const malformed = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const aws = yield* AwsCli;
        return yield* aws.getCallerIdentity("demo", "eu-west-1");
      }).pipe(Effect.provide(AwsCliLiveWithEnv({}).pipe(Layer.provide(malformedRunner)))),
    );
    expect(Exit.isFailure(malformed)).toBe(true);
  });

  it("inherited mode rejects non-SSO commands and keeps stdout/stderr empty on success", async () => {
    const runner = ProcessRunnerFake({
      runInherited: (options) =>
        Effect.succeed({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          argv: [options.command, ...(options.args ?? [])],
        }),
    });

    const ok = await Effect.runPromise(
      Effect.gen(function* () {
        const aws = yield* AwsCli;
        return yield* aws.runInheritedSso(["sso", "login", "--profile", "demo"]);
      }).pipe(Effect.provide(AwsCliLiveWithEnv({}).pipe(Layer.provide(runner)))),
    );
    expect(ok.stdout).toBe("");
    expect(ok.stderr).toBe("");

    const denied = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const aws = yield* AwsCli;
        return yield* aws.runInheritedSso(["sts", "get-caller-identity"]);
      }).pipe(Effect.provide(AwsCliLiveWithEnv({}).pipe(Layer.provide(runner)))),
    );
    expect(Exit.isFailure(denied)).toBe(true);
  });
});
