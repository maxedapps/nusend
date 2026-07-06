// Generates a Nusend API key and prints the SQL/wrangler commands to store
// its hash. The plaintext key is printed exactly once and never stored.
//
// Usage: pnpm key:create [name]

import process from "node:process";

import { apiKeyPrefix, hashApiKey } from "../src/auth/api-keys.ts";

const name = process.argv[2] ?? "default";

const secretBytes = crypto.getRandomValues(new Uint8Array(32));
const key = apiKeyPrefix + toBase64Url(secretBytes);
const keyHash = await hashApiKey(key);
const id = crypto.randomUUID();
const displayPrefix = key.slice(0, apiKeyPrefix.length + 6);

const sql = `INSERT INTO api_keys (id, name, key_prefix, key_hash) VALUES ('${id}', '${escapeSqlString(name)}', '${displayPrefix}', '${keyHash}');`;
const shellQuotedSql = `'${sql.replaceAll("'", String.raw`'\''`)}'`;

console.log(`API key '${name}' (${id})`);
console.log("");
console.log("Plaintext key (shown once, store it now):");
console.log(`  ${key}`);
console.log("");
console.log("Register it in D1:");
console.log(`  wrangler d1 execute nusend --local --command ${shellQuotedSql}`);
console.log(`  wrangler d1 execute nusend --remote --command ${shellQuotedSql}`);

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}
