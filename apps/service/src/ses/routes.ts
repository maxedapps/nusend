import { Effect } from "effect";
import { Hono } from "hono";

import { requirePrincipal } from "../auth/middleware.ts";
import { runRoute, type AppRuntime } from "../http/respond.ts";
import { runSesReadinessChecks } from "../aws/readiness.ts";
import { buildSesSetupGuide } from "./setup-guide.ts";
import { parseSesEventsQuery } from "./query.ts";
import {
  getSesEventDetail,
  getSesOperationsSummary,
  getSesSimulatorRunDetail,
  listSesEvents,
  listSesSimulatorRuns,
} from "./read-model.ts";

export function createSesOperationsRoutes(options: { readonly runtime: AppRuntime }): Hono {
  const routes = new Hono();
  const requireOperationsRead = requirePrincipal({
    permissions: { operations: ["read"] },
    runtime: options.runtime,
  });

  routes.use("/*", requireOperationsRead);

  routes.get("/summary", (context) =>
    runRoute(context, options.runtime, getSesOperationsSummary(), (result) => context.json(result)),
  );

  routes.get("/events", (context) => {
    const program = Effect.gen(function* () {
      const query = yield* parseSesEventsQuery(new URL(context.req.url).searchParams);
      return yield* listSesEvents(query);
    });
    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.get("/events/:id", (context) =>
    runRoute(context, options.runtime, getSesEventDetail(context.req.param("id")), (result) =>
      context.json(result),
    ),
  );

  routes.get("/readiness", (context) => {
    const params = new URL(context.req.url).searchParams;
    const includeAws = params.get("includeAws") !== "false";
    void params.get("refresh");
    return runRoute(context, options.runtime, runSesReadinessChecks({ includeAws }), (result) =>
      context.json(result),
    );
  });

  routes.get("/setup-guide", (context) => {
    const params = new URL(context.req.url).searchParams;
    const includeAws = params.get("includeAws") !== "false";
    void params.get("refresh");
    return runRoute(
      context,
      options.runtime,
      Effect.map(runSesReadinessChecks({ includeAws }), buildSesSetupGuide),
      (result) => context.json(result),
    );
  });

  routes.get("/simulator-runs", (context) =>
    runRoute(context, options.runtime, listSesSimulatorRuns(), (result) => context.json(result)),
  );

  routes.get("/simulator-runs/:id", (context) =>
    runRoute(
      context,
      options.runtime,
      getSesSimulatorRunDetail(context.req.param("id")),
      (result) => context.json(result),
    ),
  );

  return routes;
}
