import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  decodeStsCallerIdentity,
  isAccessDeniedText,
  isSsoSessionExpiredText,
  resolveCallerFromIdentity,
  roleNameFromArn,
} from "./sts.ts";

describe("STS identity decode", () => {
  it("decodes valid STS JSON", async () => {
    const identity = await Effect.runPromise(
      decodeStsCallerIdentity(
        JSON.stringify({
          UserId: "AROA:session",
          Account: "123456789012",
          Arn: "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_NusendProvisioner_ab12cd/user",
        }),
      ),
    );
    const caller = await Effect.runPromise(resolveCallerFromIdentity(identity));
    expect(caller.accountId).toBe("123456789012");
    expect(caller.partition).toBe("aws");
    expect(caller.roleName).toBe("NusendProvisioner");
  });

  it("rejects malformed STS JSON", async () => {
    const exit = await Effect.runPromiseExit(decodeStsCallerIdentity("{not-json"));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects missing account", async () => {
    const exit = await Effect.runPromiseExit(
      decodeStsCallerIdentity(JSON.stringify({ Arn: "arn:aws:sts::1:assumed-role/r/s" })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("extracts role names from assumed-role and role ARNs", () => {
    expect(
      roleNameFromArn("arn:aws:sts::1:assumed-role/AWSReservedSSO_Admin_deadbeef/user@example.com"),
    ).toBe("Admin");
    expect(roleNameFromArn("arn:aws-us-gov:sts::1:assumed-role/MyRole/session")).toBe("MyRole");
    expect(roleNameFromArn("arn:aws:iam::1:role/DirectRole")).toBe("DirectRole");
  });

  it("classifies expired SSO vs AccessDenied text", () => {
    expect(isSsoSessionExpiredText("Error when retrieving token from sso: Token has expired")).toBe(
      true,
    );
    expect(isSsoSessionExpiredText("AccessDenied: not authorized")).toBe(false);
    expect(isAccessDeniedText("User is not authorized to perform: sts:GetCallerIdentity")).toBe(
      true,
    );
  });
});
