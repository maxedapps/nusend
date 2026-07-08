import { createHmac } from "node:crypto";
import { Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { signPayload, signUnsubscribeToken, verifyUnsubscribeToken } from "./token.ts";

const currentSecret = "current-secret-value-with-at-least-32-chars";
const previousSecret = "previous-secret-value-with-at-least-32-chars";
const current = Redacted.make(currentSecret);
const previous = Redacted.make(previousSecret);

const secrets = [current, previous];

describe("unsubscribe tokens", () => {
  it("signs and verifies a delivery id", () => {
    const token = signUnsubscribeToken("delivery_1", current);

    expect(verifyUnsubscribeToken(token, secrets)).toEqual({
      kind: "Valid",
      payload: { d: "delivery_1", v: 1 },
    });
  });

  it("rejects malformed, tampered, and wrong-secret tokens without throwing", () => {
    const valid = signPayload({ d: "delivery_1", v: 1 }, currentSecret);
    const [payload, signature] = valid.split(".");
    const tamperedPayload = `${Buffer.from(JSON.stringify({ d: "delivery_2", v: 1 })).toString(
      "base64url",
    )}.${signature}`;
    const wrongSecret = signPayload(
      { d: "delivery_1", v: 1 },
      "wrong-secret-value-with-at-least-32-chars",
    );

    expect([
      verifyUnsubscribeToken("", secrets),
      verifyUnsubscribeToken("one-part", secrets),
      verifyUnsubscribeToken(`${payload}.short`, secrets),
      verifyUnsubscribeToken(tamperedPayload, secrets),
      verifyUnsubscribeToken(wrongSecret, secrets),
    ]).toEqual([
      { kind: "Invalid" },
      { kind: "Invalid" },
      { kind: "Invalid" },
      { kind: "Invalid" },
      { kind: "Invalid" },
    ]);
  });

  it("rejects validly signed payloads with unsupported shape", () => {
    const tokens = [
      signUnknownPayload({ d: "delivery_1", v: 2 }),
      signUnknownPayload({ d: "", v: 1 }),
      signUnknownPayload({ d: "x".repeat(201), v: 1 }),
      signUnknownPayload(["delivery_1"]),
      signUnknownPayload("delivery_1"),
    ];

    expect(tokens.map((token) => verifyUnsubscribeToken(token, secrets))).toEqual(
      tokens.map(() => ({ kind: "Invalid" })),
    );
  });

  it("verifies previous-secret tokens and signs new tokens with the current secret", () => {
    const oldToken = signPayload({ d: "old_delivery", v: 1 }, previousSecret);
    const newToken = signUnsubscribeToken("new_delivery", current);

    expect(verifyUnsubscribeToken(oldToken, secrets)).toEqual({
      kind: "Valid",
      payload: { d: "old_delivery", v: 1 },
    });
    expect(signPayload({ d: "new_delivery", v: 1 }, currentSecret)).toBe(newToken);
  });
});

function signUnknownPayload(payload: unknown): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", currentSecret).update(payloadPart).digest("base64url");
  return `${payloadPart}.${signature}`;
}
