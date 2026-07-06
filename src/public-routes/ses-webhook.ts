import { Hono } from "hono";

import type { AppEnv } from "../bindings.ts";
import { errorResponse } from "../lib/errors.ts";

// Public contract stub. The real implementation will verify the SNS signature
// and expected TopicArn, store the raw event, and process bounce/complaint/
// delivery notifications idempotently.
export function createSesWebhookRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post("/", (context) =>
    context.json(
      errorResponse("not_implemented", "The SES/SNS webhook is not implemented yet."),
      501,
    ),
  );

  return routes;
}
