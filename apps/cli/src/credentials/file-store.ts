import {
  loadCredentialFile,
  updateCredentials,
  type CredentialFile,
} from "../config/local-state.js";
import type { PathEnvironment } from "../config/paths.js";
import type { CredentialStore, StoredCredential } from "./store.js";

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly env: PathEnvironment = process.env) {}

  async delete(profile: string): Promise<boolean> {
    let deleted = false;
    await updateCredentials((current) => {
      if (current.credentials?.[profile] === undefined) return undefined;
      const credentials = { ...(current.credentials ?? {}) };
      delete credentials[profile];
      deleted = true;
      return { credentials };
    }, this.env);
    return deleted;
  }

  async hasStored(profile: string): Promise<boolean> {
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
    await updateCredentials(
      (current) => ({
        credentials: { ...(current.credentials ?? {}), [profile]: credential },
      }),
      this.env,
    );
  }

  private load(): Promise<CredentialFile> {
    return loadCredentialFile(this.env);
  }
}
