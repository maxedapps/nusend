export type SessionPrincipal = {
  kind: "session";
  organizationId: string;
  role: string;
  userId: string;
};

export type ApiKeyPrincipal = {
  apiKeyId: string;
  kind: "api_key";
  organizationId: string;
  permissions: Record<string, string[]>;
};

export type Principal = ApiKeyPrincipal | SessionPrincipal;
