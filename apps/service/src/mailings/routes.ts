import type { Database } from "bun:sqlite";
import { Hono } from "hono";

import type { AuthInstance } from "../auth/auth.ts";
import { requirePrincipal } from "../auth/middleware.ts";
import { createMailing, CreateMailingError } from "./create-mailing.ts";
import { validateCreateMailingRequest } from "./validation.ts";

type MailingsRoutesOptions = {
  auth: AuthInstance;
  db: Database;
};

export function createMailingsRoutes(options: MailingsRoutesOptions): Hono {
  const routes = new Hono();

  routes.post(
    "/",
    requirePrincipal({ auth: options.auth, db: options.db, permissions: { mailings: ["create"] } }),
    async (context) => {
      const body = await readJsonBody(context.req.raw);

      if (!body.ok) {
        return context.json(errorResponse("invalid_request", body.message), 400);
      }

      const input = validateCreateMailingRequest(body.value);

      if (!input.ok) {
        return context.json(errorResponse(input.code, input.message), 400);
      }

      try {
        const result = createMailing(options.db, input.value);

        return context.json(result, 201);
      } catch (error) {
        if (error instanceof CreateMailingError) {
          if (error.code === "list_not_found") {
            return context.json(errorResponse("not_found", error.message), 404);
          }

          return context.json(errorResponse(error.code, error.message), 422);
        }

        throw error;
      }
    },
  );

  return routes;
}

function errorResponse(
  code: string,
  message: string,
): { error: { code: string; message: string } } {
  return { error: { code, message } };
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
