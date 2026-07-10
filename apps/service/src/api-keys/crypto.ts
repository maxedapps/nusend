import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Redacted } from "effect";

const rawKeyBytes = 32;
const apiKeyPrefix = "nusend_";

export function generateRawApiKey(): string {
  return `${apiKeyPrefix}${randomBytes(rawKeyBytes).toString("base64url")}`;
}

export function hashApiKey(key: string, secret: Redacted.Redacted<string>): string {
  return createHmac("sha256", Redacted.value(secret)).update(key).digest("hex");
}

export function buildApiKeyPreview(key: string): string {
  const suffixLength = 4;
  const prefixLength = Math.min(apiKeyPrefix.length + 4, key.length);
  const suffix = key.slice(-suffixLength);
  return `${key.slice(0, prefixLength)}…${suffix}`;
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
