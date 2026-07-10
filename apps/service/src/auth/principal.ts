import type { PermissionSet } from "@nusend/api-contract/permissions";

export type SessionPrincipal = {
  kind: "session";
  userId: string;
};

export type ApiKeyPrincipal = {
  apiKeyId: string;
  kind: "api_key";
  permissions: PermissionSet;
  userId: string;
};

export type Principal = ApiKeyPrincipal | SessionPrincipal;
