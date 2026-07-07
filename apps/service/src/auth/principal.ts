export type SessionPrincipal = {
  kind: "session";
  userId: string;
};

export type ApiKeyPrincipal = {
  apiKeyId: string;
  kind: "api_key";
  permissions: Record<string, string[]>;
  userId: string;
};

export type Principal = ApiKeyPrincipal | SessionPrincipal;
