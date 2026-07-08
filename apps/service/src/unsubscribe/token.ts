import { createHmac, timingSafeEqual } from "node:crypto";
import { Result, Schema, Redacted } from "effect";

export type UnsubscribeTokenPayload = { readonly v: 1; readonly d: string };

export const maxUnsubscribeTokenLength = 2048;
export const maxDeliveryIdLength = 200;

const UnsubscribeTokenPayloadJson = Schema.fromJsonString(
  Schema.Struct({
    d: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxDeliveryIdLength)),
    v: Schema.Literals([1]),
  }),
);

export type VerifyUnsubscribeTokenResult =
  | { readonly kind: "Invalid" }
  | { readonly kind: "Valid"; readonly payload: UnsubscribeTokenPayload };

export function signUnsubscribeToken(
  deliveryId: string,
  secret: Redacted.Redacted<string>,
): string {
  return signPayload({ d: deliveryId, v: 1 }, Redacted.value(secret));
}

export function verifyUnsubscribeToken(
  token: string,
  secrets: readonly Redacted.Redacted<string>[],
): VerifyUnsubscribeTokenResult {
  const parsed = parseTokenParts(token);
  if (!parsed) return { kind: "Invalid" };

  const signatureValid = secrets.some((secret) =>
    verifySignature(parsed.payloadPart, parsed.signaturePart, Redacted.value(secret)),
  );
  if (!signatureValid) return { kind: "Invalid" };

  const payload = decodePayload(parsed.payloadPart);
  if (!payload) return { kind: "Invalid" };

  return { kind: "Valid", payload };
}

export function signPayload(payload: UnsubscribeTokenPayload, secret: string): string {
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const signaturePart = hmac(payloadPart, secret);
  return `${payloadPart}.${signaturePart}`;
}

function parseTokenParts(
  token: string,
): { readonly payloadPart: string; readonly signaturePart: string } | null {
  if (token.length === 0 || token.length > maxUnsubscribeTokenLength) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;
  return { payloadPart: parts[0], signaturePart: parts[1] };
}

function decodePayload(payloadPart: string): UnsubscribeTokenPayload | null {
  const decoded = Schema.decodeUnknownResult(UnsubscribeTokenPayloadJson)(
    Buffer.from(payloadPart, "base64url").toString("utf8"),
    { errors: "all" },
  );

  if (Result.isFailure(decoded)) return null;

  return { d: decoded.success.d, v: 1 };
}

function verifySignature(payloadPart: string, signaturePart: string, secret: string): boolean {
  try {
    const expected = Buffer.from(hmac(payloadPart, secret), "base64url");
    const actual = Buffer.from(signaturePart, "base64url");
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hmac(payloadPart: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadPart).digest("base64url");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
