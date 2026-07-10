import { CreateApiKeyRequestSchema, type CreateApiKeyRequest } from "@nusend/api-contract";
import { Effect, Result, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { requirePrincipal } from "../auth/middleware.ts";
import type { Principal } from "../auth/principal.ts";
import { RequestValidationError } from "../errors.ts";
import { paginationMeta, parsePagination } from "../http/query.ts";
import { errorEnvelope, runRoute, type AppRuntime } from "../http/respond.ts";
import { ApiKeys } from "./service.ts";

type ApiKeyRoutesOptions = {
  readonly runtime: AppRuntime;
};

export function createApiKeyRoutes(options: ApiKeyRoutesOptions): Hono {
  const routes = new Hono();
  const jsonLimit = bodyLimit({
    maxSize: 32_768,
    onError: (context) =>
      context.json(errorEnvelope("request_too_large", "Request body is too large."), 413),
  });
  const requireApiKeysRead = requirePrincipal({
    permissions: { api_keys: ["read"] },
    runtime: options.runtime,
  });
  const requireApiKeysWrite = requirePrincipal({
    permissions: { api_keys: ["write"] },
    runtime: options.runtime,
  });

  routes.get("/", requireApiKeysRead, (context) => {
    const principal = context.get("principal") as Principal;
    const program = Effect.gen(function* () {
      const pagination = yield* parsePagination(new URL(context.req.url).searchParams);
      const apiKeys = yield* ApiKeys;
      const page = yield* apiKeys.list(principal.userId, pagination);
      return { items: page.items, pagination: paginationMeta(pagination, page.hasMore) };
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.post("/", jsonLimit, requireApiKeysWrite, (context) => {
    const principal = context.get("principal") as Principal;
    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* decodeCreateApiKeyRequest(body);
      const apiKeys = yield* ApiKeys;
      const apiKey = yield* apiKeys.create({
        actorPermissions: principal.kind === "session" ? "owner" : principal.permissions,
        expiresAt: input.expiresAt ?? null,
        name: input.name,
        permissions: input.permissions,
        userId: principal.userId,
      });
      return { apiKey };
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result, 201));
  });

  routes.delete("/:id", requireApiKeysWrite, (context) => {
    const principal = context.get("principal") as Principal;
    const program = Effect.gen(function* () {
      const apiKeys = yield* ApiKeys;
      yield* apiKeys.revoke({ id: context.req.param("id"), userId: principal.userId });
    });

    return runRoute(context, options.runtime, program, () => new Response(null, { status: 204 }));
  });

  routes.post("/:id/rotate", requireApiKeysWrite, (context) => {
    const principal = context.get("principal") as Principal;
    const program = Effect.gen(function* () {
      const apiKeys = yield* ApiKeys;
      const apiKey = yield* apiKeys.rotate({
        actorPermissions: principal.kind === "session" ? "owner" : principal.permissions,
        id: context.req.param("id"),
        userId: principal.userId,
      });
      return { apiKey };
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  return routes;
}

function readJsonBody(request: Request): Effect.Effect<unknown, RequestValidationError> {
  return Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () => new RequestValidationError({ message: "Request body must be valid JSON." }),
  });
}

function decodeCreateApiKeyRequest(
  value: unknown,
): Effect.Effect<CreateApiKeyRequest, RequestValidationError> {
  const result = Schema.decodeUnknownResult(CreateApiKeyRequestSchema, { errors: "all" })(value);
  return Result.isFailure(result)
    ? Effect.fail(new RequestValidationError({ message: String(result.failure) }))
    : Effect.succeed(result.success);
}
