import type { Database } from "bun:sqlite";
import { Hono } from "hono";

import type { AuthInstance } from "./auth/auth.ts";
import { createMailingsRoutes } from "./mailings/routes.ts";

type AppOptions = {
  auth?: AuthInstance;
  db?: Database;
  pingDatabase?: () => boolean;
};

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "nusend",
    }),
  );

  app.get("/health/db", (context) => {
    if (!options.pingDatabase?.()) {
      return context.json({ ok: false }, 503);
    }

    return context.json({ ok: true });
  });

  if (options.auth) {
    const auth = options.auth;
    app.on(["GET", "POST"], ["/api/auth/*"], (context) => auth.handler(context.req.raw));
  }

  if (options.auth && options.db) {
    app.route("/api/mailings", createMailingsRoutes({ auth: options.auth, db: options.db }));
  }

  app.notFound((context) =>
    context.json(
      {
        error: {
          code: "not_found",
          message: "Not found.",
        },
      },
      404,
    ),
  );

  return app;
}
