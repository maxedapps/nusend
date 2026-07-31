import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AwsCliFake, type ResolvedCallerContext } from "../auth/aws-cli.ts";
import { SetupStoreError } from "../errors.ts";
import { SetupStoreFake } from "../services/setup-store.ts";
import { TerminalFake } from "../terminal.ts";
import { runInit } from "./init.ts";

const temps: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): { env: NodeJS.ProcessEnv; home: string } {
  const home = mkdtempSync(join(tmpdir(), "nusend-setup-init-"));
  temps.push(home);
  return { env: { ...process.env, NUSEND_SETUP_HOME: home }, home };
}

const caller: ResolvedCallerContext = {
  accountId: "123456789012",
  arn: "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_NusendProvisioner_ab12/user",
  partition: "aws",
  roleName: "NusendProvisioner",
  userId: "AROA:user",
};

const profileConfig: Record<string, string> = {
  sso_session: "nusend-demo-sso",
  sso_account_id: "123456789012",
  sso_role_name: "NusendProvisioner",
  region: "eu-west-1",
};

function awsLayer() {
  return AwsCliFake({
    listProfiles: () => Effect.succeed(["nusend-demo"]),
    configureGet: (_profile: string, key: string) => Effect.succeed(profileConfig[key] ?? null),
    configureGetSsoSession: () => Effect.succeed("us-east-1"),
    verifyProfileSession: () => Effect.succeed(caller),
  });
}

function stubLatestRelease(tag = "v0.1.2") {
  vi.stubGlobal("fetch", () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ tag_name: tag })),
    }),
  );
}

/** Prompt answers in the exact order runInit asks for them. */
function initAnswers(sshTargetAttempts: readonly string[]): string[] {
  return [
    "prod",
    "mail.example.com",
    "direct",
    "owner@example.com",
    "Owner",
    "eu-west-1",
    "123456789012",
    "example.com",
    "news@example.com",
    "n",
    "n",
    "alerts@example.com",
    "",
    ...sshTargetAttempts,
    "/srv/nusend",
    "google-client-id",
    "s3:https://acct.r2.cloudflarestorage.com/bucket/nusend",
    "r2-access-key",
    "1",
  ];
}

describe("runInit", () => {
  it("re-prompts an SSH target that deploy would reject", async () => {
    const { env, home } = tempHome();
    stubLatestRelease();
    const terminal = TerminalFake({
      answers: initAnswers(["deploy@host=bad", "deploy@host"]),
      secretAnswers: ["google-secret", "r2-secret"],
    });

    const state = await Effect.runPromise(
      runInit(env).pipe(
        Effect.provide(Layer.mergeAll(terminal.layer, SetupStoreFake(), awsLayer())),
      ),
    );

    expect(state.config.sshTarget).toBe("deploy@host");
    expect(terminal.state.stdout.join("")).toMatch(/SSH target is not a conservative/i);
    await expect(readFile(join(home, "prod/state.json"), "utf8")).resolves.toContain('"init"');
  });

  it("leaves no installation marked init-complete when the pointer write fails", async () => {
    const { env, home } = tempHome();
    stubLatestRelease();
    const terminal = TerminalFake({
      answers: initAnswers(["deploy@host"]),
      secretAnswers: ["google-secret", "r2-secret"],
    });
    const store = SetupStoreFake({
      writeCurrentPointer: () =>
        Effect.fail(new SetupStoreError({ message: "pointer write failed", reason: "io" })),
    });

    const exit = await Effect.runPromiseExit(
      runInit(env).pipe(Effect.provide(Layer.mergeAll(terminal.layer, store, awsLayer()))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const body = await readFile(join(home, "prod/state.json"), "utf8").catch(() => null);
    if (body !== null) {
      expect(JSON.parse(body).stages?.init).toBeUndefined();
    }
  });
});
