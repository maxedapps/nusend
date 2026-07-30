import { Redacted } from "effect";

import { DEPLOYMENT_ENV_KEYS, SECRET_ENV_KEY_SET } from "./constants.ts";

/** Plain string env map as stored on disk. */
export type PlainEnvMap = Record<string, string>;

/**
 * In-memory deployment env: secret keys are Redacted after parse.
 * Unwrap only when serializing the protected env file or an external boundary.
 */
export type DeploymentEnvMap = Record<string, string | Redacted.Redacted<string>>;

export function isRedactedEnvValue(
  value: string | Redacted.Redacted<string>,
): value is Redacted.Redacted<string> {
  return Redacted.isRedacted(value);
}

export function unwrapEnvValue(value: string | Redacted.Redacted<string>): string {
  return isRedactedEnvValue(value) ? Redacted.value(value) : value;
}

export function redactDeploymentEnv(values: PlainEnvMap): DeploymentEnvMap {
  const out: DeploymentEnvMap = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = SECRET_ENV_KEY_SET.has(key) ? Redacted.make(value) : value;
  }
  return out;
}

export function plainDeploymentEnv(values: DeploymentEnvMap): PlainEnvMap {
  const out: PlainEnvMap = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = unwrapEnvValue(value);
  }
  return out;
}

/**
 * Parse KEY=VALUE env files without shell expansion.
 * Rejects exports, shell syntax, and duplicate keys.
 */
export function parseEnvFile(raw: string): PlainEnvMap {
  if (typeof raw !== "string") {
    throw new Error("deployment.env must be a UTF-8 string.");
  }
  const out: PlainEnvMap = {};
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line == null) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^(export|unset)\b/u.test(trimmed)) {
      throw new Error(`deployment.env line ${index + 1}: shell directives are not allowed.`);
    }
    const match = /^(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/u.exec(line);
    if (!match?.groups) {
      throw new Error(`deployment.env line ${index + 1}: expected KEY=VALUE.`);
    }
    const { key, value } = match.groups;
    if (Object.hasOwn(out, key)) {
      throw new Error(`deployment.env line ${index + 1}: duplicate key ${key}.`);
    }
    out[key] = unquoteEnvValue(value, index + 1);
  }
  return out;
}

export function serializeEnvFile(values: Record<string, string | undefined | null>): string {
  const lines: string[] = [];
  for (const key of DEPLOYMENT_ENV_KEYS) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (value == null) continue;
    lines.push(`${key}=${quoteEnvValue(String(value))}`);
  }
  const extras = Object.keys(values)
    .filter((key) => !(DEPLOYMENT_ENV_KEYS as readonly string[]).includes(key))
    .sort((a, b) => a.localeCompare(b));
  for (const key of extras) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid env key "${key}".`);
    }
    const value = values[key];
    if (value == null) continue;
    lines.push(`${key}=${quoteEnvValue(String(value))}`);
  }
  return `${lines.join("\n")}\n`;
}

export function serializeDeploymentEnv(values: DeploymentEnvMap): string {
  return serializeEnvFile(plainDeploymentEnv(values));
}

function unquoteEnvValue(value: string, lineNumber: number): string {
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error(`deployment.env line ${lineNumber}: unterminated single quote.`);
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new Error(`deployment.env line ${lineNumber}: unterminated double quote.`);
    }
    const body = value.slice(1, -1);
    if (/\\([^nrt"\\])/u.test(body)) {
      throw new Error(`deployment.env line ${lineNumber}: unsupported escape sequence.`);
    }
    return body
      .replace(/\\n/gu, "\n")
      .replace(/\\r/gu, "\r")
      .replace(/\\t/gu, "\t")
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, "\\");
  }
  if (/[\s#]/u.test(value) || value.includes("'") || value.includes('"')) {
    throw new Error(
      `deployment.env line ${lineNumber}: unquoted values must not contain whitespace, quotes, or #.`,
    );
  }
  if (value.startsWith("$") || value.includes("`") || value.includes("$(")) {
    throw new Error(`deployment.env line ${lineNumber}: shell expansion is not allowed.`);
  }
  return value;
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/u.test(value)) return value;
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")}"`;
}

/** Collect secret plain values for redaction of process output (length >= 4). */
export function secretValuesFromEnv(envMap: DeploymentEnvMap | PlainEnvMap): string[] {
  const secrets: string[] = [];
  for (const key of SECRET_ENV_KEY_SET) {
    const value = envMap[key];
    if (value == null) continue;
    const plain = unwrapEnvValue(value as string | Redacted.Redacted<string>);
    if (plain.length >= 4) secrets.push(plain);
  }
  return secrets;
}
