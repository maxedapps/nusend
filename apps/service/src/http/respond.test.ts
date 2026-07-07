// Exhaustive error-mapping coverage for runRoute: every RouteError tag maps to
// its frozen status/code, and infrastructure failures/defects map to 500
// internal_error without leaking details.
import { Effect } from "effect";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  AuthError,
  DatabaseError,
  EmptyRecipientSetError,
  ForbiddenError,
  ListNotFoundError,
  RequestValidationError,
  UnauthenticatedError,
} from "../errors.ts";
import { makeTestRuntime } from "../testing/layers.ts";
import { runRoute, type RouteError } from "./respond.ts";

async function respondWith(failure: Effect.Effect<never, RouteError>): Promise<Response> {
  const runtime = makeTestRuntime();

  try {
    const app = new Hono();
    app.get("/probe", (context) =>
      runRoute(context, runtime, failure, () => context.json({ ok: true })),
    );

    return await app.fetch(new Request("http://localhost/probe"));
  } finally {
    await runtime.dispose();
  }
}

describe("runRoute error mapping", () => {
  it.each([
    [
      new UnauthenticatedError({ message: "Authentication required." }),
      401,
      "unauthenticated",
      "Authentication required.",
    ],
    [new ForbiddenError({ message: "Forbidden thing." }), 403, "forbidden", "Forbidden thing."],
    [new RequestValidationError({ message: "Bad field." }), 400, "invalid_request", "Bad field."],
    [new ListNotFoundError({ listId: "missing" }), 404, "not_found", "List not found."],
    [
      new EmptyRecipientSetError({ reason: "No recipients." }),
      422,
      "empty_recipient_set",
      "No recipients.",
    ],
  ] as const)("maps %o", async (error, status, code, message) => {
    const response = await respondWith(Effect.fail(error));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code, message } });
  });

  it.each([
    [new DatabaseError({ cause: new Error("secret sql detail"), operation: "probe" })],
    [new AuthError({ cause: new Error("secret auth detail"), operation: "probe" })],
  ] as const)("maps infrastructure failure %o to a sanitized 500", async (error) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await respondWith(Effect.fail(error));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Internal error." },
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("maps defects to a sanitized 500", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await respondWith(Effect.die(new Error("unexpected crash detail")));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Internal error." },
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("runs onSuccess for successful programs", async () => {
    const runtime = makeTestRuntime();

    try {
      const app = new Hono();
      app.get("/probe", (context) =>
        runRoute(context, runtime, Effect.succeed(41), (value) =>
          context.json({ value: value + 1 }, 201),
        ),
      );

      const response = await app.fetch(new Request("http://localhost/probe"));
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({ value: 42 });
    } finally {
      await runtime.dispose();
    }
  });
});
