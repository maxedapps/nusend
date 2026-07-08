import { Effect, Result } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { requirePrincipal } from "../auth/middleware.ts";
import { RequestValidationError } from "../errors.ts";
import { errorEnvelope, runRoute, type AppRuntime } from "../http/respond.ts";
import { createOrGetContact, deleteContact, updateContactEmail } from "./write.ts";
import {
  decodeContactEmailBody,
  maxContactRequestBodyBytes,
  parseContactId,
  parseContactsListQuery,
  type ContactEmailInput,
} from "./schema.ts";
import { getContactDetail, listContacts } from "./read-model.ts";

type ContactsRoutesOptions = {
  readonly runtime: AppRuntime;
};

export function createContactsRoutes(options: ContactsRoutesOptions): Hono {
  const routes = new Hono();
  const requireContactsRead = requirePrincipal({
    permissions: { contacts: ["read"] },
    runtime: options.runtime,
  });
  const requireContactsWrite = requirePrincipal({
    permissions: { contacts: ["write"] },
    runtime: options.runtime,
  });
  const jsonLimit = bodyLimit({
    maxSize: maxContactRequestBodyBytes,
    onError: (context) =>
      context.json(errorEnvelope("request_too_large", "Request body is too large."), 413),
  });

  routes.post("/", jsonLimit, requireContactsWrite, (context) => {
    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* decodeToEffect(decodeContactEmailBody(body));
      return yield* createOrGetContact(input.email);
    });

    return runRoute(context, options.runtime, program, (result) =>
      context.json(result, result.created ? 201 : 200),
    );
  });

  routes.get("/", requireContactsRead, (context) => {
    const program = Effect.gen(function* () {
      const query = yield* parseContactsListQuery(new URL(context.req.url).searchParams);
      return yield* listContacts(query);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.get("/:id", requireContactsRead, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseContactId(context.req.param("id"));
      return yield* getContactDetail(id);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.patch("/:id", jsonLimit, requireContactsWrite, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseContactId(context.req.param("id"));
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* decodeToEffect(decodeContactEmailBody(body));
      return yield* updateContactEmail(id, input.email);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.delete("/:id", requireContactsWrite, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseContactId(context.req.param("id"));
      yield* deleteContact(id);
    });

    return runRoute(context, options.runtime, program, () => new Response(null, { status: 204 }));
  });

  return routes;
}

function readJsonBody(request: Request): Effect.Effect<unknown, RequestValidationError> {
  return Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () => new RequestValidationError({ message: "Request body must be valid JSON." }),
  });
}

function decodeToEffect(
  decoded: Result.Result<ContactEmailInput, RequestValidationError>,
): Effect.Effect<ContactEmailInput, RequestValidationError> {
  return Result.isFailure(decoded) ? Effect.fail(decoded.failure) : Effect.succeed(decoded.success);
}
