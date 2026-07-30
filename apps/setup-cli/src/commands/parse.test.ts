import { describe, expect, it } from "vitest";

import { UsageError } from "../errors.ts";
import { HELP_TEXT, normalizeArgv, parseSetupArgv } from "./parse.ts";

describe("setup command grammar", () => {
  it("strips leading pnpm -- separators", () => {
    expect(normalizeArgv(["--", "--help"])).toEqual(["--help"]);
    expect(normalizeArgv(["--", "--", "status", "--refresh"])).toEqual(["status", "--refresh"]);
  });

  it("parses bare start as guided", () => {
    expect(parseSetupArgv([])).toEqual({ kind: "guided" });
    expect(parseSetupArgv(["--"])).toEqual({ kind: "guided" });
  });

  it("parses help without mutation semantics", () => {
    expect(parseSetupArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseSetupArgv(["-h"])).toEqual({ kind: "help" });
    expect(parseSetupArgv(["help"])).toEqual({ kind: "help" });
  });

  it("parses init/doctor/status/continue and aws auth|permissions", () => {
    expect(parseSetupArgv(["init"])).toEqual({ kind: "init" });
    expect(parseSetupArgv(["doctor"])).toEqual({ kind: "doctor" });
    expect(parseSetupArgv(["status"])).toEqual({ kind: "status", refresh: false });
    expect(parseSetupArgv(["status", "--refresh"])).toEqual({
      kind: "status",
      refresh: true,
    });
    expect(parseSetupArgv(["continue"])).toEqual({ kind: "continue" });
    expect(parseSetupArgv(["aws", "auth"])).toEqual({ kind: "aws", action: "auth" });
    expect(parseSetupArgv(["aws", "permissions"])).toEqual({
      kind: "aws",
      action: "permissions",
    });
  });

  it("keeps grammar for plan/apply/validate/destroy", () => {
    expect(parseSetupArgv(["aws", "plan"])).toEqual({ kind: "aws", action: "plan" });
    expect(parseSetupArgv(["aws", "apply"])).toEqual({ kind: "aws", action: "apply" });
    expect(parseSetupArgv(["deploy", "plan"])).toEqual({ kind: "deploy", action: "plan" });
    expect(parseSetupArgv(["validate", "final"])).toEqual({
      kind: "validate",
      action: "final",
    });
    expect(parseSetupArgv(["destroy", "apply"])).toEqual({
      kind: "destroy",
      action: "apply",
    });
  });

  it("rejects unknown commands and bad flags with UsageError", () => {
    expect(() => parseSetupArgv(["nope"])).toThrow(UsageError);
    expect(() => parseSetupArgv(["status", "--wat"])).toThrow(UsageError);
    expect(() => parseSetupArgv(["aws"])).toThrow(UsageError);
    expect(() => parseSetupArgv(["aws", "login"])).toThrow(UsageError);
  });

  it("help text documents public launcher and aws auth/permissions", () => {
    expect(HELP_TEXT.startsWith("Usage: pnpm nusend:setup")).toBe(true);
    expect(HELP_TEXT).toContain("(none)");
    expect(HELP_TEXT).toContain("aws auth");
    expect(HELP_TEXT).toContain("aws permissions");
    expect(HELP_TEXT).toContain("status [--refresh]");
    expect(HELP_TEXT).toMatch(/sso_session|Identity Center/iu);
  });
});
