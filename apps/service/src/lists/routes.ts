import { Effect } from "effect";
import { Hono } from "hono";

import { requirePrincipal } from "../auth/middleware.ts";
import { jsonBodyLimit, readJsonBody, resultToEffect } from "../http/body.ts";
import { runRoute, type AppRuntime } from "../http/respond.ts";
import { parsePagination } from "../http/query.ts";
import { getList, listListContacts, listLists } from "./read-model.ts";
import {
  createList,
  deleteList,
  importListContacts,
  unsubscribeListContact,
  updateList,
} from "./write.ts";
import {
  decodeImportListContactsBody,
  decodeListNameBody,
  maxListImportRequestBodyBytes,
  maxListRequestBodyBytes,
  parseContactId,
  parseListContactsQuery,
  parseListId,
} from "./schema.ts";

type ListsRoutesOptions = {
  readonly runtime: AppRuntime;
};

export function createListsRoutes(options: ListsRoutesOptions): Hono {
  const routes = new Hono();
  const requireListsRead = requirePrincipal({
    permissions: { lists: ["read"] },
    runtime: options.runtime,
  });
  const requireListsWrite = requirePrincipal({
    permissions: { lists: ["write"] },
    runtime: options.runtime,
  });
  const jsonLimit = jsonBodyLimit(maxListRequestBodyBytes);
  const importLimit = jsonBodyLimit(maxListImportRequestBodyBytes);

  routes.post("/", jsonLimit, requireListsWrite, (context) => {
    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* resultToEffect(decodeListNameBody(body));
      return yield* createList(input.name);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result, 201));
  });

  routes.get("/", requireListsRead, (context) => {
    const program = Effect.gen(function* () {
      const pagination = yield* parsePagination(new URL(context.req.url).searchParams);
      return yield* listLists(pagination);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.get("/:id", requireListsRead, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseListId(context.req.param("id"));
      return yield* getList(id);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.patch("/:id", jsonLimit, requireListsWrite, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseListId(context.req.param("id"));
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* resultToEffect(decodeListNameBody(body));
      return yield* updateList(id, input.name);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.delete("/:id", requireListsWrite, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseListId(context.req.param("id"));
      yield* deleteList(id);
    });

    return runRoute(context, options.runtime, program, () => new Response(null, { status: 204 }));
  });

  routes.get("/:id/contacts", requireListsRead, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseListId(context.req.param("id"));
      const query = yield* parseListContactsQuery(new URL(context.req.url).searchParams);
      return yield* listListContacts(id, query);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.post("/:id/contacts", importLimit, requireListsWrite, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseListId(context.req.param("id"));
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* resultToEffect(decodeImportListContactsBody(body));
      return yield* importListContacts(
        id,
        input.contacts.map((contact) => contact.email),
      );
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.delete("/:id/contacts/:contactId", requireListsWrite, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseListId(context.req.param("id"));
      const contactId = yield* parseContactId(context.req.param("contactId"));
      yield* unsubscribeListContact(id, contactId);
    });

    return runRoute(context, options.runtime, program, () => new Response(null, { status: 204 }));
  });

  return routes;
}
