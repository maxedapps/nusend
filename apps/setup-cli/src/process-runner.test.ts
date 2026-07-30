import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";

import { CancellationError, ProcessFailedError, ProcessSignalError } from "./errors.ts";
import {
  assertInheritedAwsSsoAllowed,
  classifyInheritedAwsSso,
  ProcessRunner,
  ProcessRunnerLive,
  redactText,
} from "./process-runner.ts";

function run<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(effect);
}

describe("ProcessRunner", () => {
  it("runs argv arrays without a shell and captures stdout", async () => {
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* ProcessRunner;
        return yield* processes.runCaptured({
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.argv[1])", "hello-argv"],
        });
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("hello-argv");
    expect(result.argv[0]).toBe(process.execPath);
    expect(result.argv).toContain("hello-argv");
  });

  it("does not evaluate shell metacharacters in argv", async () => {
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* ProcessRunner;
        return yield* processes.runCaptured({
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.argv[1])", "a;b|c&&d"],
        });
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(result.stdout).toBe("a;b|c&&d");
  });

  it("propagates nonzero exit codes as ProcessFailedError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const processes = yield* ProcessRunner;
        return yield* processes.runCaptured({
          command: process.execPath,
          args: ["-e", "process.exit(7)"],
        });
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(ProcessFailedError);
        expect(error.value).toMatchObject({ _tag: "ProcessFailedError", exitCode: 7 });
      }
    }
  });

  it("allows nonzero exit when requested", async () => {
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* ProcessRunner;
        return yield* processes.runCaptured({
          command: process.execPath,
          args: ["-e", "process.exit(3)"],
          allowNonZero: true,
        });
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(result.exitCode).toBe(3);
  });

  it("propagates termination signals as ProcessSignalError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const processes = yield* ProcessRunner;
        return yield* processes.runCaptured({
          command: process.execPath,
          args: ["-e", "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"],
        });
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(ProcessSignalError);
        expect(error.value).toMatchObject({ _tag: "ProcessSignalError", signal: "SIGTERM" });
      }
    }
  });

  it("redacts secrets from failure output and helper text", async () => {
    const secret = "super-secret-value-zz";
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const processes = yield* ProcessRunner;
        return yield* processes.runCaptured({
          command: process.execPath,
          args: ["-e", `console.error('leak ${secret}'); process.exit(1)`],
          redact: [secret],
        });
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(ProcessFailedError);
        const failed = error.value as ProcessFailedError;
        expect(failed.message).toMatch(/leak \*\*\*/);
        expect(failed.message).not.toContain(secret);
        expect(failed.stderr).toContain("***");
        expect(failed.stderr).not.toContain(secret);
      }
    }

    expect(redactText(`token=${secret}`, [secret])).toBe("token=***");
    expect(redactText("short", ["ab"])).toBe("short");
  });

  it("passes stdin without shell interpolation", async () => {
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* ProcessRunner;
        return yield* processes.runCaptured({
          command: process.execPath,
          args: [
            "-e",
            "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))",
          ],
          stdin: "line-one\n",
        });
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(result.stdout).toBe("line-one\n");
  });

  it("maps fiber interruption to CancellationError and stops the child", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const processes = yield* ProcessRunner;
        const fiber = yield* Effect.forkChild(
          processes.runCaptured({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
          }),
        );
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const typed = Cause.findErrorOption(exit.cause);
      const cancelled = Option.isSome(typed) && typed.value instanceof CancellationError;
      const interrupted = Cause.hasInterrupts(exit.cause);
      expect(cancelled || interrupted).toBe(true);
    }
  });

  it("runInherited returns empty stdout/stderr and still uses argv arrays", async () => {
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* ProcessRunner;
        return yield* processes.runInherited({
          command: process.execPath,
          // Write only if somehow captured later; inherited mode must leave result streams empty.
          args: ["-e", "process.exit(0)"],
        });
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.argv[0]).toBe(process.execPath);
    expect(result.argv.slice(1)).toEqual(["-e", "process.exit(0)"]);
  });

  it("uses provided env as the complete child environment without process.env merge", async () => {
    const marker = `nusend-setup-env-${Date.now()}`;
    const previous = process.env.AWS_ACCESS_KEY_ID;
    process.env.AWS_ACCESS_KEY_ID = "AKIA_SHOULD_NOT_LEAK_INTO_CHILD";
    try {
      const result = await run(
        Effect.gen(function* () {
          const processes = yield* ProcessRunner;
          return yield* processes.runCaptured({
            command: process.execPath,
            args: [
              "-e",
              "process.stdout.write([process.env.AWS_ACCESS_KEY_ID||'',process.env.NUSEND_TEST_MARKER||''].join('|'))",
            ],
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              NUSEND_TEST_MARKER: marker,
              AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
            },
          });
        }).pipe(Effect.provide(ProcessRunnerLive)),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`|${marker}`);
      expect(result.stdout).not.toContain("AKIA_SHOULD_NOT_LEAK_INTO_CHILD");
    } finally {
      if (previous === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = previous;
    }
  });
});

describe("inherited AWS SSO allowlist helper", () => {
  it("allows only aws configure sso and aws sso login", () => {
    expect(classifyInheritedAwsSso("aws", ["configure", "sso", "--profile", "x"])).toBe(
      "configure-sso",
    );
    expect(classifyInheritedAwsSso("aws", ["sso", "login", "--profile", "x"])).toBe("sso-login");
    expect(classifyInheritedAwsSso("aws", ["sts", "get-caller-identity"])).toBeNull();
    expect(classifyInheritedAwsSso("bash", ["-c", "aws sso login"])).toBeNull();

    expect(assertInheritedAwsSsoAllowed("aws", ["configure", "sso"])).toBe("configure-sso");
    expect(assertInheritedAwsSsoAllowed("aws", ["sso", "login"])).toBe("sso-login");
    expect(() => assertInheritedAwsSsoAllowed("aws", ["configure", "list"])).toThrow(
      /restricted to `aws configure sso` and `aws sso login`/,
    );
    expect(() => assertInheritedAwsSsoAllowed("aws", ["sso", "logout"])).toThrow(/restricted/);
  });
});
