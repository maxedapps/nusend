import { Effect } from "effect";
import { Hono } from "hono";

import { requirePrincipal } from "../auth/middleware.ts";
import { parseRouteId } from "../http/query.ts";
import { runRoute, type AppRuntime } from "../http/respond.ts";
import { getDeliveryDetail, getOperationsSummary, listDeliveries } from "./read-model.ts";
import { parseDeliveriesQuery } from "./query.ts";

type OperationsRoutesOptions = {
  runtime: AppRuntime;
};

export function createOperationsRoutes(options: OperationsRoutesOptions): Hono {
  const routes = new Hono();
  const requireOperationsRead = requirePrincipal({
    permissions: { operations: ["read"] },
    runtime: options.runtime,
  });

  routes.get("/summary", requireOperationsRead, (context) =>
    runRoute(context, options.runtime, getOperationsSummary(), (result) => context.json(result)),
  );

  routes.get("/deliveries", requireOperationsRead, (context) => {
    const program = Effect.gen(function* () {
      const query = yield* parseDeliveriesQuery(new URL(context.req.url).searchParams);
      return yield* listDeliveries(query);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.get("/deliveries/:id", requireOperationsRead, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseRouteId(context.req.param("id"), "delivery id");
      return yield* getDeliveryDetail(id);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  return routes;
}
