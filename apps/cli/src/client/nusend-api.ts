import {
  ContactDetailResponseSchema,
  ContactResponseSchema,
  ContactsListResponseSchema,
  CreateApiKeyResponseSchema,
  CreateContactResponseSchema,
  CreateMailingResponseSchema,
  CreateSuppressionResponseSchema,
  DeliveriesListResponseSchema,
  DeliveryDetailResponseSchema,
  DeviceAuthorizationStartResponseSchema,
  DeviceAuthorizationTokenResponseSchema,
  ImportListContactsResponseSchema,
  ListApiKeysResponseSchema,
  ListContactsResponseSchema,
  ListResponseSchema,
  ListsListResponseSchema,
  MailingDetailResponseSchema,
  MailingsListResponseSchema,
  MeResponseSchema,
  OperationsSummaryResponseSchema,
  RotateApiKeyResponseSchema,
  SesEventDetailResponseSchema,
  SesEventsListResponseSchema,
  SesReadinessResponseSchema,
  SesSetupGuideResponseSchema,
  SesSimulatorRunDetailResponseSchema,
  SesSimulatorRunsListResponseSchema,
  SesSummaryResponseSchema,
  SuppressionsListResponseSchema,
  routes,
  type ContactDetailResponse,
  type ContactEmailRequest,
  type ContactResponse,
  type ContactsListResponse,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type CreateContactResponse,
  type CreateMailingRequest,
  type CreateMailingResponse,
  type CreateSuppressionRequest,
  type CreateSuppressionResponse,
  type DeliveriesListResponse,
  type DeliveryDetailResponse,
  type DeliveryStatus,
  type DeviceAuthorizationStartRequest,
  type DeviceAuthorizationStartResponse,
  type DeviceAuthorizationTokenResponse,
  type ImportListContactsRequest,
  type ImportListContactsResponse,
  type ListApiKeysResponse,
  type ListContactsResponse,
  type ListNameRequest,
  type ListResponse,
  type ListsListResponse,
  type MailingDetailResponse,
  type MailingsListResponse,
  type MeResponse,
  type OperationsSummaryResponse,
  type RotateApiKeyResponse,
  type SesEventDetailResponse,
  type SesEventsListResponse,
  type SesEventType,
  type SesReadinessResponse,
  type SesSetupGuideResponse,
  type SesSimulatorRunDetailResponse,
  type SesSimulatorRunsListResponse,
  type SesSummaryResponse,
  type SuppressionReason,
  type SuppressionScope,
  type SuppressionsListResponse,
} from "@nusend/api-contract";
import { Schema } from "effect";

import type { NusendHttpClient } from "./http.js";

type PaginationQuery = {
  readonly limit?: string;
  readonly offset?: string;
};

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

  listContacts(query: PaginationQuery & { readonly email?: string }) {
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

  listApiKeys(query: PaginationQuery = {}) {
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

  createMailing(body: CreateMailingRequest, idempotencyKey?: string) {
    return this.http.request<CreateMailingResponse>({
      body,
      headers: idempotencyKey === undefined ? undefined : { "Idempotency-Key": idempotencyKey },
      method: "POST",
      path: routes.mailings.create,
      schema: CreateMailingResponseSchema,
    });
  }

  listMailings(query: PaginationQuery) {
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

  createList(body: ListNameRequest) {
    return this.http.request<ListResponse>({
      body,
      method: "POST",
      path: routes.lists.list,
      schema: ListResponseSchema,
    });
  }

  listLists(query: PaginationQuery = {}) {
    return this.http.request<ListsListResponse>({
      path: withQuery(routes.lists.list, query),
      schema: ListsListResponseSchema,
    });
  }

  getList(id: string) {
    return this.http.request<ListResponse>({
      path: routes.lists.byId(id),
      schema: ListResponseSchema,
    });
  }

  updateList(id: string, body: ListNameRequest) {
    return this.http.request<ListResponse>({
      body,
      method: "PATCH",
      path: routes.lists.byId(id),
      schema: ListResponseSchema,
    });
  }

  deleteList(id: string) {
    return this.http.request<null>({
      method: "DELETE",
      path: routes.lists.byId(id),
      schema: EmptyResponseSchema,
    });
  }

  listListContacts(
    listId: string,
    query: PaginationQuery & {
      readonly email?: string;
      readonly status?: "all" | "subscribed" | "unsubscribed";
    } = {},
  ) {
    return this.http.request<ListContactsResponse>({
      path: withQuery(routes.lists.contacts(listId), query),
      schema: ListContactsResponseSchema,
    });
  }

  importListContacts(listId: string, body: ImportListContactsRequest) {
    return this.http.request<ImportListContactsResponse>({
      body,
      method: "POST",
      path: routes.lists.contacts(listId),
      schema: ImportListContactsResponseSchema,
    });
  }

  removeListContact(listId: string, contactId: string) {
    return this.http.request<null>({
      method: "DELETE",
      path: routes.lists.contact(listId, contactId),
      schema: EmptyResponseSchema,
    });
  }

  createSuppression(body: CreateSuppressionRequest) {
    return this.http.request<CreateSuppressionResponse>({
      body,
      method: "POST",
      path: routes.suppressions.list,
      schema: CreateSuppressionResponseSchema,
    });
  }

  listSuppressions(
    query: PaginationQuery & {
      readonly email?: string;
      readonly listId?: string;
      readonly reason?: SuppressionReason;
      readonly scope?: SuppressionScope;
    } = {},
  ) {
    return this.http.request<SuppressionsListResponse>({
      path: withQuery(routes.suppressions.list, query),
      schema: SuppressionsListResponseSchema,
    });
  }

  deleteSuppression(id: string) {
    return this.http.request<null>({
      method: "DELETE",
      path: routes.suppressions.byId(id),
      schema: EmptyResponseSchema,
    });
  }

  getOperationsSummary() {
    return this.http.request<OperationsSummaryResponse>({
      path: routes.operations.summary,
      schema: OperationsSummaryResponseSchema,
    });
  }

  listDeliveries(
    query: {
      readonly email?: string;
      readonly issue?: "failed_or_ambiguous";
      readonly limit?: string;
      readonly mailingId?: string;
      readonly sesMessageId?: string;
      readonly status?: DeliveryStatus;
    } = {},
  ) {
    return this.http.request<DeliveriesListResponse>({
      path: withQuery(routes.operations.deliveries, query),
      schema: DeliveriesListResponseSchema,
    });
  }

  getDelivery(id: string) {
    return this.http.request<DeliveryDetailResponse>({
      path: routes.operations.delivery(id),
      schema: DeliveryDetailResponseSchema,
    });
  }

  getSesSummary() {
    return this.http.request<SesSummaryResponse>({
      path: routes.operations.sesSummary,
      schema: SesSummaryResponseSchema,
    });
  }

  listSesEvents(
    query: PaginationQuery & {
      readonly deliveryId?: string;
      readonly email?: string;
      readonly eventType?: SesEventType;
      readonly mailingId?: string;
      readonly sesMessageId?: string;
    } = {},
  ) {
    return this.http.request<SesEventsListResponse>({
      path: withQuery(routes.operations.sesEvents, query),
      schema: SesEventsListResponseSchema,
    });
  }

  getSesEvent(id: string) {
    return this.http.request<SesEventDetailResponse>({
      path: routes.operations.sesEvent(id),
      schema: SesEventDetailResponseSchema,
    });
  }

  getSesReadiness(query: { readonly includeAws?: boolean } = {}) {
    return this.http.request<SesReadinessResponse>({
      path: withQuery(routes.operations.sesReadiness, query),
      schema: SesReadinessResponseSchema,
    });
  }

  getSesSetupGuide(query: { readonly includeAws?: boolean } = {}) {
    return this.http.request<SesSetupGuideResponse>({
      path: withQuery(routes.operations.sesSetupGuide, query),
      schema: SesSetupGuideResponseSchema,
    });
  }

  listSesSimulatorRuns() {
    return this.http.request<SesSimulatorRunsListResponse>({
      path: routes.operations.sesSimulatorRuns,
      schema: SesSimulatorRunsListResponseSchema,
    });
  }

  getSesSimulatorRun(id: string) {
    return this.http.request<SesSimulatorRunDetailResponse>({
      path: routes.operations.sesSimulatorRun(id),
      schema: SesSimulatorRunDetailResponseSchema,
    });
  }

  whoami() {
    return this.http.request<MeResponse>({ path: routes.me, schema: MeResponseSchema });
  }
}

function withQuery(path: string, query: Record<string, boolean | string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}

const EmptyResponseSchema = Schema.Null;
