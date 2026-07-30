import { SECRET_ENV_KEY_SET } from "./constants.ts";

function isSecretishKey(key: string): boolean {
  return /(password|secret|token|access_key|private)/iu.test(key);
}

/**
 * Remove secret-bearing keys from plan/status/state metadata.
 * Never logs or returns secret values.
 */
export function sanitizePlanMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_ENV_KEY_SET.has(key) || isSecretishKey(key)) continue;
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizePlanMetadata(value as Record<string, unknown>);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item != null && typeof item === "object" && !Array.isArray(item)
          ? sanitizePlanMetadata(item as Record<string, unknown>)
          : item,
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}
