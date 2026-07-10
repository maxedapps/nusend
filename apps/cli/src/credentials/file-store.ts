import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";

import { credentialsPath, type PathEnvironment } from "../config/paths.js";
import type { CredentialStore, StoredCredential } from "./store.js";

const CredentialFileSchema = Schema.Struct({
  credentials: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        apiKey: Schema.String,
        apiKeyId: Schema.optional(Schema.String),
        createdAt: Schema.optional(Schema.String),
        preview: Schema.optional(Schema.String),
      }),
    ),
  ),
});

type CredentialFile = typeof CredentialFileSchema.Type;

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly env: PathEnvironment = process.env) {}

  async delete(profile: string): Promise<void> {
    if (!(await this.fileExists())) return;
    const file = await this.load();
    const credentials = { ...(file.credentials ?? {}) };
    delete credentials[profile];
    await this.save({ credentials });
  }

  async hasStored(profile: string): Promise<boolean> {
    if (!(await this.fileExists())) return false;
    const file = await this.load();
    return file.credentials?.[profile] !== undefined;
  }

  async read(profile: string): Promise<StoredCredential | null> {
    const envKey = this.env.NUSEND_API_KEY;
    if (envKey) return { apiKey: envKey };
    const file = await this.load();
    return file.credentials?.[profile] ?? null;
  }

  async write(profile: string, credential: StoredCredential): Promise<void> {
    const file = await this.load();
    await this.save({ credentials: { ...(file.credentials ?? {}), [profile]: credential } });
  }

  private async fileExists(): Promise<boolean> {
    try {
      await stat(credentialsPath(this.env));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private async load(): Promise<CredentialFile> {
    const path = credentialsPath(this.env);
    try {
      if (process.platform !== "win32") {
        await assertPrivatePath(dirname(path), "Credential directory");
        await assertPrivatePath(path, "Credential file");
      }
      const raw = await readFile(path, "utf8");
      return Schema.decodeUnknownSync(CredentialFileSchema)(JSON.parse(raw));
    } catch (error) {
      if (isNotFound(error)) return { credentials: {} };
      throw error;
    }
  }

  private async save(file: CredentialFile): Promise<void> {
    const path = credentialsPath(this.env);
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    if (process.platform !== "win32") await chmod(dirname(path), 0o700).catch(() => undefined);
    const temp = `${path}.tmp-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, path);
  }
}

async function assertPrivatePath(path: string, label: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${label} permissions are too broad. Run \`nusend config repair-permissions\`.`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
