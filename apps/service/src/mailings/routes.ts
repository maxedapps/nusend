import { Effect, Result } from "effect";
import { Hono } from "hono";

import { requirePrincipal } from "../auth/middleware.ts";
import { RequestValidationError } from "../errors.ts";
import { runRoute, type AppRuntime } from "../http/respond.ts";
import { createMailing } from "./create-mailing.ts";
import { decodeCreateMailingRequest, type CreateMailingInput } from "./schema.ts";

type MailingsRoutesOptions = {
  runtime: AppRuntime;
};

export function createMailingsRoutes(options: MailingsRoutesOptions): Hono {
  const routes = new Hono();

  routes.post(
    "/",
    requirePrincipal({ permissions: { mailings: ["create"] }, runtime: options.runtime }),
    (context) => {
      const program = Effect.gen(function* () {
        const body = yield* Effect.tryPromise({
          try: () => context.req.raw.json() as Promise<unknown>,
          catch: () => new RequestValidationError({ message: "Request body must be valid JSON." }),
        });

        const input: CreateMailingInput = yield* decodeToEffect(decodeCreateMailingRequest(body));

        return yield* createMailing(input);
      });

      return runRoute(context, options.runtime, program, (result) => context.json(result, 201));
    },
  );

  return routes;
}

function decodeToEffect(
  decoded: Result.Result<CreateMailingInput, RequestValidationError>,
): Effect.Effect<CreateMailingInput, RequestValidationError> {
  return Result.isFailure(decoded) ? Effect.fail(decoded.failure) : Effect.succeed(decoded.success);
}
