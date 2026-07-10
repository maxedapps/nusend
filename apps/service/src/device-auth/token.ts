import { createHmac, randomBytes } from "node:crypto";
import { Redacted } from "effect";

const userCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

export function generateUserCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((byte) => userCodeAlphabet[byte % userCodeAlphabet.length] ?? "X");
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}

export function normalizeUserCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function hashDeviceAuthCode(value: string, secret: Redacted.Redacted<string>): string {
  return createHmac("sha256", Redacted.value(secret)).update(value).digest("hex");
}
