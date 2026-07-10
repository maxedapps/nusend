import {
  ContactDetailResponseSchema,
  ContactResponseSchema,
  ContactsListResponseSchema,
  CreateApiKeyResponseSchema,
  CreateContactResponseSchema,
  DeviceAuthorizationStartResponseSchema,
  DeviceAuthorizationTokenResponseSchema,
  ListApiKeysResponseSchema,
  MailingDetailResponseSchema,
  MailingsListResponseSchema,
  MeResponseSchema,
  RotateApiKeyResponseSchema,
  routes,
  type ContactDetailResponse,
  type ContactEmailRequest,
  type ContactResponse,
  type ContactsListResponse,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type CreateContactResponse,
  type DeviceAuthorizationStartRequest,
  type DeviceAuthorizationStartResponse,
  type DeviceAuthorizationTokenResponse,
  type ListApiKeysResponse,
  type MailingDetailResponse,
  type MailingsListResponse,
  type MeResponse,
  type RotateApiKeyResponse,
} from "@nusend/api-contract";
import { Schema } from "effect";

import type { NusendHttpClient } from "./http.js";

export class NusendApi {
  constructor(private readonly http: NusendHttpClient) {}

  createContact(body: ContactEmailRequest) {
    return this.http.request<CreateContactResponse>({
      body,
      method: "POST",
      path: routes.contacts.list,
      schema: CreateContactResponseSchema,
    });
  }

  deleteContact(id: string) {
    return this.http.request<null>({
      method: "DELETE",
      path: routes.contacts.byId(id),
      schema: EmptyResponseSchema,
    });
  }

  getContact(id: string) {
    return this.http.request<ContactDetailResponse>({
      path: routes.contacts.byId(id),
      schema: ContactDetailResponseSchema,
    });
  }

  listContacts(query: {
    readonly email?: string;
    readonly limit?: string;
    readonly offset?: string;
  }) {
    return this.http.request<ContactsListResponse>({
      path: withQuery(routes.contacts.list, query),
      schema: ContactsListResponseSchema,
    });
  }

  updateContact(id: string, body: ContactEmailRequest) {
    return this.http.request<ContactResponse>({
      body,
      method: "PATCH",
      path: routes.contacts.byId(id),
      schema: ContactResponseSchema,
    });
  }

  createApiKey(body: CreateApiKeyRequest) {
    return this.http.request<CreateApiKeyResponse>({
      body,
      method: "POST",
      path: routes.apiKeys.list,
      schema: CreateApiKeyResponseSchema,
    });
  }

  listApiKeys(query: { readonly limit?: string; readonly offset?: string } = {}) {
    return this.http.request<ListApiKeysResponse>({
      path: withQuery(routes.apiKeys.list, query),
      schema: ListApiKeysResponseSchema,
    });
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.http.request<null>({
      method: "DELETE",
      path: routes.apiKeys.byId(id),
      schema: EmptyResponseSchema,
    });
  }

  rotateApiKey(id: string) {
    return this.http.request<RotateApiKeyResponse>({
      method: "POST",
      path: routes.apiKeys.rotate(id),
      schema: RotateApiKeyResponseSchema,
    });
  }

  startDeviceAuthorization(body: DeviceAuthorizationStartRequest) {
    return this.http.request<DeviceAuthorizationStartResponse>({
      body,
      method: "POST",
      path: routes.deviceAuthorizations.start,
      schema: DeviceAuthorizationStartResponseSchema,
    });
  }

  pollDeviceAuthorization(deviceCode: string): Promise<DeviceAuthorizationTokenResponse> {
    return this.http.request<DeviceAuthorizationTokenResponse>({
      body: { deviceCode },
      method: "POST",
      path: routes.deviceAuthorizations.token,
      schema: DeviceAuthorizationTokenResponseSchema,
    });
  }

  listMailings(query: { readonly limit?: string; readonly offset?: string }) {
    return this.http.request<MailingsListResponse>({
      path: withQuery(routes.mailings.list, query),
      schema: MailingsListResponseSchema,
    });
  }

  getMailing(id: string) {
    return this.http.request<MailingDetailResponse>({
      path: routes.mailings.byId(id),
      schema: MailingDetailResponseSchema,
    });
  }

  whoami() {
    return this.http.request<MeResponse>({ path: routes.me, schema: MeResponseSchema });
  }
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}

const EmptyResponseSchema = Schema.Null;
