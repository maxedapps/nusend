import { Hono } from "hono";

type AppOptions = {
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
