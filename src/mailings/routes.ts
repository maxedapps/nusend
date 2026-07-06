import { Hono } from "hono";

import type { AppEnv } from "../bindings.ts";
import { errorResponse } from "../lib/errors.ts";
import { createMailing, CreateMailingError } from "./create-mailing.ts";
import { getMailingSummary } from "./get-mailing.ts";
import { validateCreateMailingRequest } from "./validation.ts";

export function createMailingsRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post("/", async (context) => {
    const body = await readJsonBody(context.req.raw);

    if (!body.ok) {
      return context.json(errorResponse("invalid_request", body.message), 400);
    }

    const input = validateCreateMailingRequest(body.value);

    if (!input.ok) {
      return context.json(errorResponse(input.code, input.message), 400);
    }

    if (input.value.purpose === "marketing") {
      return context.json(
        errorResponse(
          "marketing_unsubscribe_not_available",
          "Marketing sending is disabled until Nusend has unsubscribe support.",
        ),
        422,
      );
    }

    try {
      const result = await createMailing(context.env.DB, input.value);

      // The create is durably committed at this point; a failed poke must not
      // fail the request (the cron watchdog re-pokes), so run it detached.
      const dispatcher = context.env.DISPATCHER.get(
        context.env.DISPATCHER.idFromName("dispatcher"),
      );
      context.executionCtx.waitUntil(
        dispatcher.poke().catch((error: unknown) => {
          console.error("Dispatcher poke failed:", error);
        }),
      );

      return context.json(result, input.value.listId ? 202 : 201);
    } catch (error) {
      if (error instanceof CreateMailingError) {
        if (error.code === "list_not_found") {
          return context.json(errorResponse("not_found", error.message), 404);
        }

        return context.json(errorResponse(error.code, error.message), 422);
      }

      throw error;
    }
  });

  routes.get("/:id", async (context) => {
    const summary = await getMailingSummary(context.env.DB, context.req.param("id"));

    if (!summary) {
      return context.json(errorResponse("not_found", "Mailing not found."), 404);
    }

    return context.json(summary);
  });

  return routes;
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { message: string; ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { message: "Request body must be valid JSON.", ok: false };
  }
}
