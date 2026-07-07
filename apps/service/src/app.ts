import { Effect } from "effect";
import { Hono } from "hono";

import { errorEnvelope, runRoute, type AppRuntime } from "./http/respond.ts";
import { createMailingsRoutes } from "./mailings/routes.ts";
import { Auth } from "./services/auth.ts";
import { Database } from "./services/database.ts";

type AppOptions = {
  runtime: AppRuntime;
};

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

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
  app.on(["GET", "POST"], ["/api/auth/*"], (context) =>
    runRoute(
      context,
      options.runtime,
      Effect.flatMap(Auth, (auth) => Effect.promise(() => auth.handler(context.req.raw))),
      (response) => response,
    ),
  );

  app.route("/api/mailings", createMailingsRoutes({ runtime: options.runtime }));

  app.notFound((context) => context.json(errorEnvelope("not_found", "Not found."), 404));

  return app;
}
