import { Hono } from "hono";

import { requirePrincipal } from "./middleware.ts";
import type { Principal } from "./principal.ts";
import { type AppRuntime } from "../http/respond.ts";

type MeRoutesOptions = {
  readonly runtime: AppRuntime;
};

export function createMeRoutes(options: MeRoutesOptions): Hono {
  const routes = new Hono();

  routes.get("/", requirePrincipal({ runtime: options.runtime }), (context) => {
    const principal = context.get("principal") as Principal;
    return context.json({
      principal:
        principal.kind === "session"
          ? { kind: "session", permissions: "owner", userId: principal.userId }
          : {
              apiKeyId: principal.apiKeyId,
              kind: "api_key",
              permissions: principal.permissions,
              userId: principal.userId,
            },
    });
  });

  return routes;
}
