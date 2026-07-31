import { Effect, Option } from "effect";
import { Hono } from "hono";

import { requirePrincipal } from "../auth/middleware.ts";
import { RequestValidationError } from "../errors.ts";
import { jsonBodyLimit, readJsonBody, resultToEffect } from "../http/body.ts";
import { parsePagination, parseRouteId } from "../http/query.ts";
import { runRoute, type AppRuntime } from "../http/respond.ts";
import { containsUnsubscribeUrlPlaceholder } from "../sending/render.ts";
import { UnsubscribeConfig, type UnsubscribeConfigService } from "../unsubscribe/config.ts";
import {
  createMailingIdempotent,
  maxIdempotencyKeyLength,
  normalizeIdempotencyKey,
} from "./idempotency.ts";
import { getMailingDetail, listMailings } from "./read-model.ts";
import {
  decodeCreateMailingRequest,
  maxMailingRequestBodyBytes,
  type CreateMailingInput,
} from "./schema.ts";

type MailingsRoutesOptions = {
  runtime: AppRuntime;
};

export function createMailingsRoutes(options: MailingsRoutesOptions): Hono {
  const routes = new Hono();
  const requireMailingsRead = requirePrincipal({
    permissions: { mailings: ["read"] },
    runtime: options.runtime,
  });
  const requireMailingsWrite = requirePrincipal({
    permissions: { mailings: ["write"] },
    runtime: options.runtime,
  });

  routes.get("/", requireMailingsRead, (context) => {
    const program = Effect.gen(function* () {
      const pagination = yield* parsePagination(new URL(context.req.url).searchParams);
      return yield* listMailings(pagination);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.get("/:id", requireMailingsRead, (context) => {
    const program = Effect.gen(function* () {
      const id = yield* parseRouteId(context.req.param("id"), "mailing id");
      return yield* getMailingDetail(id);
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result));
  });

  routes.post("/", jsonBodyLimit(maxMailingRequestBodyBytes), requireMailingsWrite, (context) => {
    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(context.req.raw);
      const input: CreateMailingInput = yield* resultToEffect(decodeCreateMailingRequest(body));
      const idempotencyKey = yield* normalizeRouteIdempotencyKey(
        context.req.header("Idempotency-Key"),
      );

      return yield* createMailingIdempotent({
        beforeCreate: validateMarketingCompliance(input),
        idempotencyKey,
        input,
      });
    });

    return runRoute(context, options.runtime, program, (result) => context.json(result, 201));
  });

  return routes;
}

function validateMarketingCompliance(
  input: CreateMailingInput,
): Effect.Effect<void, RequestValidationError, UnsubscribeConfigService> {
  if (input.purpose !== "marketing") return Effect.void;

  return Effect.gen(function* () {
    const unsubscribe = yield* UnsubscribeConfig;
    if (Option.isNone(unsubscribe.config)) {
      return yield* Effect.fail(
        new RequestValidationError({
          message: "Marketing mailings require unsubscribe configuration.",
        }),
      );
    }

    if (!containsUnsubscribeUrlPlaceholder(input.html)) {
      return yield* Effect.fail(
        new RequestValidationError({
          message: "Marketing mailings must include {{ unsubscribe.url }} in the HTML template.",
        }),
      );
    }
  });
}

function normalizeRouteIdempotencyKey(
  value: string | null | undefined,
): Effect.Effect<string | null, RequestValidationError> {
  const key = normalizeIdempotencyKey(value);
  if (key === null && value !== undefined && value !== null) {
    return Effect.fail(
      new RequestValidationError({ message: "Idempotency-Key must not be blank." }),
    );
  }

  if (key !== null && key.length > maxIdempotencyKeyLength) {
    return Effect.fail(
      new RequestValidationError({
        message: `Idempotency-Key must be at most ${maxIdempotencyKeyLength} characters.`,
      }),
    );
  }

  return Effect.succeed(key);
}
