import { Hono } from "hono";

import type { AppEnv } from "../bindings.ts";
import { errorResponse } from "../lib/errors.ts";

// Public contract stub. The real implementation will verify a signed token
// and update suppressions/list membership.
export function createUnsubscribeRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const notImplemented = errorResponse("not_implemented", "Unsubscribe is not implemented yet.");

  routes.get("/:token", (context) => context.json(notImplemented, 501));
  routes.post("/:token", (context) => context.json(notImplemented, 501));

  return routes;
}
