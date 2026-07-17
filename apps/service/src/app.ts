import { Effect } from "effect";
import { Hono } from "hono";

import { createApiKeyRoutes } from "./api-keys/routes.ts";
import { createMeRoutes } from "./auth/me-routes.ts";
import { createContactsRoutes } from "./contacts/routes.ts";
import { createActivationRoutes } from "./device-auth/activate-routes.ts";
import { createDeviceAuthorizationRoutes } from "./device-auth/routes.ts";
import {
  errorEnvelope,
  respondUnexpectedError,
  runRoute,
  type AppRuntime,
} from "./http/respond.ts";
import { sanitizedLogPath } from "./observability/safe-log-fields.ts";
import { createListsRoutes } from "./lists/routes.ts";
import { createMailingsRoutes } from "./mailings/routes.ts";
import { createOperationsRoutes } from "./operations/routes.ts";
import { Auth } from "./services/auth.ts";
import { Database } from "./services/database.ts";
import { createSesOperationsRoutes } from "./ses/routes.ts";
import { createSesWebhookRoutes } from "./ses/webhook-routes.ts";
import { createSuppressionsRoutes } from "./suppressions/routes.ts";
import { createUnsubscribeRoutes } from "./unsubscribe/routes.ts";

type AppOptions = {
  runtime: AppRuntime;
  // Canonical public origin (BETTER_AUTH_URL) for proxy-correct same-origin
  // checks and verification URLs; falls back to the request origin when unset.
  publicOrigin?: string;
};

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    const path = new URL(context.req.url).pathname;
    if (path === "/health" || path === "/health/db") {
      await next();
      return;
    }

    const started = performance.now();
    // try/finally so the access-log line is emitted even for a request whose
    // handler throws (onError turns it into the 500 response, so context.res.status
    // reflects it here).
    try {
      await next();
    } finally {
      await options.runtime.runPromise(
        Effect.logInfo("http request completed", {
          durationMs: Math.round(performance.now() - started),
          method: context.req.method,
          path: sanitizedLogPath(path),
          status: context.res.status,
        }),
      );
    }
  });

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "nusend",
    }),
  );

  app.get("/health/db", (context) =>
    runRoute(
      context,
      options.runtime,
      Effect.flatMap(Database, (db) => db.ping),
      (alive) => (alive ? context.json({ ok: true }) : context.json({ ok: false }, 503)),
    ),
  );

  // Raw passthrough — Better Auth owns these routes entirely.
  app.on(["DELETE", "GET", "PATCH", "POST", "PUT"], ["/api/auth/*"], (context) =>
    runRoute(
      context,
      options.runtime,
      Effect.flatMap(Auth, (auth) => Effect.promise(() => auth.handler(context.req.raw))),
      (response) => response,
    ),
  );

  app.route(
    "/cli",
    createActivationRoutes({ publicOrigin: options.publicOrigin, runtime: options.runtime }),
  );
  app.route("/unsubscribe", createUnsubscribeRoutes({ runtime: options.runtime }));
  app.route("/api/webhooks", createSesWebhookRoutes({ runtime: options.runtime }));

  app.route("/api/api-keys", createApiKeyRoutes({ runtime: options.runtime }));
  app.route("/api/contacts", createContactsRoutes({ runtime: options.runtime }));
  app.route(
    "/api/device-authorizations",
    createDeviceAuthorizationRoutes({
      publicOrigin: options.publicOrigin,
      runtime: options.runtime,
    }),
  );
  app.route("/api/lists", createListsRoutes({ runtime: options.runtime }));
  app.route("/api/mailings", createMailingsRoutes({ runtime: options.runtime }));
  app.route("/api/me", createMeRoutes({ runtime: options.runtime }));
  app.route("/api/operations", createOperationsRoutes({ runtime: options.runtime }));
  app.route("/api/operations/ses", createSesOperationsRoutes({ runtime: options.runtime }));
  app.route("/api/suppressions", createSuppressionsRoutes({ runtime: options.runtime }));

  app.notFound((context) => context.json(errorEnvelope("not_found", "Not found."), 404));

  // Backstop for any exception thrown in a handler/middleware: sanitized log +
  // the JSON error contract, instead of Hono's default (unsanitized stack via
  // console.error + text/plain 500).
  app.onError((error, context) => respondUnexpectedError(context, options.runtime, error));

  return app;
}
