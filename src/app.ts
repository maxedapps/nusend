import { Hono } from "hono";

import { requireApiKey } from "./auth/api-keys.ts";
import type { AppEnv } from "./bindings.ts";
import { errorResponse } from "./lib/errors.ts";
import { createMailingsRoutes } from "./mailings/routes.ts";
import { createSesWebhookRoutes } from "./public-routes/ses-webhook.ts";
import { createUnsubscribeRoutes } from "./public-routes/unsubscribe.ts";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "nusend",
    }),
  );

  app.route("/unsubscribe", createUnsubscribeRoutes());
  app.route("/webhooks/ses", createSesWebhookRoutes());

  app.use("/api/*", requireApiKey());
  app.route("/api/mailings", createMailingsRoutes());

  app.notFound((context) => context.json(errorResponse("not_found", "Not found."), 404));

  app.onError((error, context) => {
    console.error("Unhandled error:", error);
    return context.json(errorResponse("internal_error", "Internal server error."), 500);
  });

  return app;
}
