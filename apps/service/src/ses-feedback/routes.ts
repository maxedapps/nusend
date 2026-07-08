import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { runWebhookRoute, type AppRuntime } from "../http/respond.ts";
import { handleSesFeedbackSnsRequest } from "./process.ts";

export const maxSesFeedbackWebhookBodyBytes = 512 * 1024;

type SesFeedbackRoutesOptions = {
  readonly runtime: AppRuntime;
};

export function createSesFeedbackRoutes(options: SesFeedbackRoutesOptions): Hono {
  const routes = new Hono();

  routes.post(
    "/aws/sns/ses",
    bodyLimit({
      maxSize: maxSesFeedbackWebhookBodyBytes,
      onError: () => new Response(null, { status: 413 }),
    }),
    async (context) => {
      const rawBody = await context.req.text();
      return runWebhookRoute(
        context,
        options.runtime,
        handleSesFeedbackSnsRequest(rawBody),
        () => new Response(null, { status: 204 }),
      );
    },
  );

  return routes;
}
