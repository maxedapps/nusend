import { Hono } from "hono";

import type { AuthInstance } from "./auth/auth.ts";

type AppOptions = {
  auth?: Pick<AuthInstance, "handler">;
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
