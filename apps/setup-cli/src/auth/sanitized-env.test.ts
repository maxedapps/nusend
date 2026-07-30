import { describe, expect, it } from "vitest";

import {
  AWS_ENV_ALLOW_EXACT,
  AWS_ENV_DENY_EXACT,
  buildSanitizedAwsEnv,
  isDeniedAwsEnvKey,
} from "./sanitized-env.ts";

describe("sanitized AWS child environment", () => {
  it("strips the complete credential/profile denylist and endpoint overrides", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/op",
      AWS_PROFILE: "ambient",
      AWS_DEFAULT_PROFILE: "ambient-default",
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_SECURITY_TOKEN: "sectok",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/wit",
      AWS_ROLE_ARN: "arn:aws:iam::1:role/x",
      AWS_ROLE_SESSION_NAME: "sess",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/v2",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "ctok",
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/tmp/ctok",
      AWS_SHARED_CREDENTIALS_FILE: "/tmp/creds",
      AWS_ENDPOINT_URL: "https://evil.example",
      AWS_ENDPOINT_URL_STS: "https://sts.evil.example",
      AWS_ENDPOINT_URL_SSO: "https://sso.evil.example",
      AWS_REGION: "eu-central-1",
      AWS_DEFAULT_REGION: "ap-south-1",
      AWS_CONFIG_FILE: "/custom/config",
      AWS_CA_BUNDLE: "/etc/ssl/certs/ca.pem",
      OTHER: "keep",
    };

    const env = buildSanitizedAwsEnv(parent);

    for (const key of AWS_ENV_DENY_EXACT) {
      if (key === "AWS_SHARED_CREDENTIALS_FILE") continue;
      expect(env[key], key).toBeUndefined();
    }
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL_STS).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL_SSO).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();

    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe("/dev/null");
    expect(env.AWS_EC2_METADATA_DISABLED).toBe("true");
    expect(env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe("true");

    expect(env.AWS_CONFIG_FILE).toBe("/custom/config");
    expect(env.AWS_CA_BUNDLE).toBe("/etc/ssl/certs/ca.pem");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/op");
    expect(env.OTHER).toBe("keep");
  });

  it("forces /dev/null credentials, disabled IMDS, and configured-endpoint ignore even when absent in parent", () => {
    const env = buildSanitizedAwsEnv({ PATH: "/bin" });
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe("/dev/null");
    expect(env.AWS_EC2_METADATA_DISABLED).toBe("true");
    expect(env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe("true");
  });

  it("denies unknown AWS_* keys fail-closed while allowing reviewed config/CA keys", () => {
    expect(isDeniedAwsEnvKey("AWS_PROFILE")).toBe(true);
    expect(isDeniedAwsEnvKey("AWS_ENDPOINT_URL_S3")).toBe(true);
    expect(isDeniedAwsEnvKey("AWS_SOMETHING_NEW")).toBe(true);
    for (const key of AWS_ENV_ALLOW_EXACT) {
      expect(isDeniedAwsEnvKey(key)).toBe(false);
    }
    expect(isDeniedAwsEnvKey("PATH")).toBe(false);
  });

  it("does not preserve ambient shared credentials file path", () => {
    const env = buildSanitizedAwsEnv({
      AWS_SHARED_CREDENTIALS_FILE: "/home/op/.aws/credentials",
    });
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe("/dev/null");
  });
});
