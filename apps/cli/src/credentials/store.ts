export type StoredCredential = {
  readonly apiKey: string;
  readonly apiKeyId?: string;
  readonly createdAt?: string;
  readonly preview?: string;
};

export interface CredentialStore {
  readonly delete: (profile: string) => Promise<void>;
  readonly hasStored: (profile: string) => Promise<boolean>;
  readonly read: (profile: string) => Promise<StoredCredential | null>;
  readonly write: (profile: string, credential: StoredCredential) => Promise<void>;
}
