import { Effect } from "effect";
import { Hono } from "hono";

import { requirePrincipal } from "../auth/middleware.ts";
import { jsonBodyLimit, readJsonBody, resultToEffect } from "../http/body.ts";
import { runRoute, type AppRuntime } from "../http/respond.ts";
import { listSuppressions } from "./read-model.ts";
import { createManualSuppression, deleteManualSuppression } from "./write.ts";
import {
  decodeCreateSuppressionBody,
  maxSuppressionRequestBodyBytes,
  parseSuppressionId,
  parseSuppressionsListQuery,
} from "./schema.ts";

type SuppressionsRoutesOptions = {
  readonly runtime: AppRuntime;
};

export function createSuppressionsRoutes(options: SuppressionsRoutesOptions): Hono {
  const routes = new Hono();
  const requireSuppressionsRead = requirePrincipal({
    permissions: { suppressions: ["read"] },
    runtime: options.runtime,
  });
  const requireSuppressionsWrite = requirePrincipal({
    permissions: { suppressions: ["write"] },
    runtime: options.runtime,
  });
  const jsonLimit = jsonBodyLimit(maxSuppressionRequestBodyBytes);

  routes.post("/", jsonLimit, requireSuppressionsWrite, (context) => {
    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(context.req.raw);
      const input = yield* resultToEffect(decodeCreateSuppressionBody(body));
      return yield* createManualSuppression(input);
    });

    return runRoute(context, options.runtime, program, (result) =>
      context.json(result, result.created ? 201 : 200),
    );
  });

  routes.get("/", requireSuppressionsRead, (context) => {
    const program = Effect.gen(function* () {
      const query = yield* parseSuppressionsListQuery(new URL(context.req.url).searchParams);
      return yield* listSuppressions(query);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.delete("/:id", requireSuppressionsWrite, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseSuppressionId(context.req.param("id"));
      yield* deleteManualSuppression(id);
    });

    return runRoute(context, options.runtime, program, () => new Response(null, { status: 204 }));
  });

  return routes;
}
