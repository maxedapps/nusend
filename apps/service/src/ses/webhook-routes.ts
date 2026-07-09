import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { runWebhookRoute, type AppRuntime } from "../http/respond.ts";
import { sesSnsWebhookPath } from "./constants.ts";
import { handleSesSnsRequest } from "./process-event.ts";

export const maxSesWebhookBodyBytes = 512 * 1024;

type SesWebhookRoutesOptions = {
  readonly runtime: AppRuntime;
};

export function createSesWebhookRoutes(options: SesWebhookRoutesOptions): Hono {
  const routes = new Hono();
  const localPath = sesSnsWebhookPath.replace(/^\/api\/webhooks/, "");

  routes.post(
    localPath,
    bodyLimit({
      maxSize: maxSesWebhookBodyBytes,
      onError: () => new Response(null, { status: 413 }),
    }),
    async (context) => {
      const rawBody = await context.req.text();
      return runWebhookRoute(
        context,
        options.runtime,
        handleSesSnsRequest(rawBody),
        () => new Response(null, { status: 204 }),
      );
    },
  );

  return routes;
}
