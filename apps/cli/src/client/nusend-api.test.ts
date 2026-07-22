import {
  CreateMailingResponseSchema,
  CreateSuppressionResponseSchema,
  DeliveriesListResponseSchema,
  DeliveryDetailResponseSchema,
  ImportListContactsResponseSchema,
  ListContactsResponseSchema,
  ListResponseSchema,
  ListsListResponseSchema,
  OperationsSummaryResponseSchema,
  SesEventDetailResponseSchema,
  SesEventsListResponseSchema,
  SesReadinessResponseSchema,
  SesSetupGuideResponseSchema,
  SesSimulatorRunDetailResponseSchema,
  SesSimulatorRunsListResponseSchema,
  SesSummaryResponseSchema,
  SuppressionsListResponseSchema,
} from "@nusend/api-contract";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { NusendHttpClient, type HttpHeaders } from "./http.js";
import { NusendApi } from "./nusend-api.js";

type RecordedRequest = {
  readonly body?: unknown;
  readonly headers?: HttpHeaders;
  readonly method?: string;
  readonly path: string;
  readonly schema: unknown;
};

function recordingApi(): { readonly api: NusendApi; readonly calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const http = {
    request: <A, I = A>(input: {
      readonly body?: unknown;
      readonly headers?: HttpHeaders;
      readonly method?: string;
      readonly path: string;
      readonly schema: Schema.Codec<A, I>;
    }): Promise<A> => {
      calls.push(input);
      return Promise.resolve(null as A);
    },
  };
  return { api: new NusendApi(http as unknown as NusendHttpClient), calls };
}

function callWithMethod(call: RecordedRequest): RecordedRequest & { readonly method: string } {
  return { ...call, method: call.method ?? "GET" };
}

describe("NusendApi", () => {
  it("sends mailing creation with its exact body and optional idempotency header", async () => {
    const { api, calls } = recordingApi();
    const body = {
      html: "<p>Hello</p>",
      purpose: "transactional" as const,
      recipients: [{ email: "person@example.test", vars: { name: "Person" } }],
      subject: "Hello",
    };

    await api.createMailing(body, "mailing-attempt-1");
    await api.createMailing(body);

    expect(callWithMethod(calls[0]!)).toEqual({
      body,
      headers: { "Idempotency-Key": "mailing-attempt-1" },
      method: "POST",
      path: "/api/mailings",
      schema: CreateMailingResponseSchema,
    });
    expect(callWithMethod(calls[1]!)).toEqual({
      body,
      headers: undefined,
      method: "POST",
      path: "/api/mailings",
      schema: CreateMailingResponseSchema,
    });
  });

  it("covers list CRUD and memberships with exact encoded paths, queries, and bodies", async () => {
    const { api, calls } = recordingApi();
    const listBody = { name: "Customers" };
    const importBody = {
      contacts: [{ email: "first@example.test" }, { email: "second@example.test" }],
    };

    await api.createList(listBody);
    await api.listLists({ limit: "10", offset: "20" });
    await api.getList("list/one");
    await api.updateList("list two", listBody);
    await api.deleteList("list/three");
    await api.listListContacts("list/four", {
      email: "person+tag@example.test",
      status: "unsubscribed",
      limit: "5",
      offset: "10",
    });
    await api.importListContacts("list five", importBody);
    await api.removeListContact("list/six", "contact/seven");

    expect(calls.map(callWithMethod)).toEqual([
      {
        body: listBody,
        method: "POST",
        path: "/api/lists",
        schema: ListResponseSchema,
      },
      {
        method: "GET",
        path: "/api/lists?limit=10&offset=20",
        schema: ListsListResponseSchema,
      },
      {
        method: "GET",
        path: "/api/lists/list%2Fone",
        schema: ListResponseSchema,
      },
      {
        body: listBody,
        method: "PATCH",
        path: "/api/lists/list%20two",
        schema: ListResponseSchema,
      },
      {
        method: "DELETE",
        path: "/api/lists/list%2Fthree",
        schema: Schema.Null,
      },
      {
        method: "GET",
        path: "/api/lists/list%2Ffour/contacts?email=person%2Btag%40example.test&status=unsubscribed&limit=5&offset=10",
        schema: ListContactsResponseSchema,
      },
      {
        body: importBody,
        method: "POST",
        path: "/api/lists/list%20five/contacts",
        schema: ImportListContactsResponseSchema,
      },
      {
        method: "DELETE",
        path: "/api/lists/list%2Fsix/contacts/contact%2Fseven",
        schema: Schema.Null,
      },
    ]);
  });

  it("covers suppressions and operations with exact filters and encoded IDs", async () => {
    const { api, calls } = recordingApi();
    const suppressionBody = {
      email: "person@example.test",
      listId: "list-1",
      scope: "list" as const,
    };

    await api.createSuppression(suppressionBody);
    await api.listSuppressions({
      email: "person@example.test",
      scope: "list",
      reason: "manual",
      listId: "list/1",
      limit: "12",
      offset: "24",
    });
    await api.deleteSuppression("suppression/1");
    await api.getOperationsSummary();
    await api.listDeliveries({
      email: "person@example.test",
      issue: "failed_or_ambiguous",
      limit: "25",
      mailingId: "mailing/1",
      sesMessageId: "ses message",
      status: "failed",
    });
    await api.getDelivery("delivery/1");

    expect(calls.map(callWithMethod)).toEqual([
      {
        body: suppressionBody,
        method: "POST",
        path: "/api/suppressions",
        schema: CreateSuppressionResponseSchema,
      },
      {
        method: "GET",
        path: "/api/suppressions?email=person%40example.test&scope=list&reason=manual&listId=list%2F1&limit=12&offset=24",
        schema: SuppressionsListResponseSchema,
      },
      {
        method: "DELETE",
        path: "/api/suppressions/suppression%2F1",
        schema: Schema.Null,
      },
      {
        method: "GET",
        path: "/api/operations/summary",
        schema: OperationsSummaryResponseSchema,
      },
      {
        method: "GET",
        path: "/api/operations/deliveries?email=person%40example.test&issue=failed_or_ambiguous&limit=25&mailingId=mailing%2F1&sesMessageId=ses+message&status=failed",
        schema: DeliveriesListResponseSchema,
      },
      {
        method: "GET",
        path: "/api/operations/deliveries/delivery%2F1",
        schema: DeliveryDetailResponseSchema,
      },
    ]);
  });

  it("covers every SES read route and only supported query keys", async () => {
    const { api, calls } = recordingApi();

    await api.getSesSummary();
    await api.listSesEvents({
      deliveryId: "delivery/1",
      email: "person@example.test",
      eventType: "Rendering Failure",
      limit: "20",
      mailingId: "mailing/1",
      offset: "40",
      sesMessageId: "ses message",
    });
    await api.getSesEvent("event/1");
    await api.getSesReadiness({ includeAws: false });
    await api.getSesSetupGuide({ includeAws: false });
    await api.listSesSimulatorRuns();
    await api.getSesSimulatorRun("run/1");

    expect(calls.map(callWithMethod)).toEqual([
      {
        method: "GET",
        path: "/api/operations/ses/summary",
        schema: SesSummaryResponseSchema,
      },
      {
        method: "GET",
        path: "/api/operations/ses/events?deliveryId=delivery%2F1&email=person%40example.test&eventType=Rendering+Failure&limit=20&mailingId=mailing%2F1&offset=40&sesMessageId=ses+message",
        schema: SesEventsListResponseSchema,
      },
      {
        method: "GET",
        path: "/api/operations/ses/events/event%2F1",
        schema: SesEventDetailResponseSchema,
      },
      {
        method: "GET",
        path: "/api/operations/ses/readiness?includeAws=false",
        schema: SesReadinessResponseSchema,
      },
      {
        method: "GET",
        path: "/api/operations/ses/setup-guide?includeAws=false",
        schema: SesSetupGuideResponseSchema,
      },
      {
        method: "GET",
        path: "/api/operations/ses/simulator-runs",
        schema: SesSimulatorRunsListResponseSchema,
      },
      {
        method: "GET",
        path: "/api/operations/ses/simulator-runs/run%2F1",
        schema: SesSimulatorRunDetailResponseSchema,
      },
    ]);
  });

  it("decodes 204 responses as null for empty list, membership, and suppression routes", async () => {
    const requests: Array<{ readonly method: string | undefined; readonly url: string }> = [];
    const http = new NusendHttpClient({
      baseUrl: "https://api.example.test",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ method: init?.method, url: String(url) });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const api = new NusendApi(http);

    await expect(api.deleteList("list/1")).resolves.toBeNull();
    await expect(api.removeListContact("list/1", "contact/2")).resolves.toBeNull();
    await expect(api.deleteSuppression("suppression/3")).resolves.toBeNull();
    expect(requests).toEqual([
      { method: "DELETE", url: "https://api.example.test/api/lists/list%2F1" },
      {
        method: "DELETE",
        url: "https://api.example.test/api/lists/list%2F1/contacts/contact%2F2",
      },
      {
        method: "DELETE",
        url: "https://api.example.test/api/suppressions/suppression%2F3",
      },
    ]);
  });
});
