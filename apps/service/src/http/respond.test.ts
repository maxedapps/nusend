// Exhaustive error-mapping coverage for runRoute: every RouteError tag maps to
// its frozen status/code, and infrastructure failures/defects map to 500
// internal_error without leaking details.
import { Effect, Logger } from "effect";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  AuthError,
  DatabaseError,
  EmptyRecipientSetError,
  ForbiddenError,
  IdempotencyConflictError,
  RecipientLimitExceededError,
  ListNotFoundError,
  NotFoundError,
  RequestValidationError,
  UnauthenticatedError,
} from "../errors.ts";
import { makeTestRuntime, type CapturedLog } from "../testing/layers.ts";
import { runRoute, type RouteError } from "./respond.ts";

async function respondWith(
  failure: Effect.Effect<never, RouteError>,
  logSink: CapturedLog[] = [],
): Promise<Response> {
  const runtime = makeTestRuntime({ logSink });

  try {
    const app = new Hono();
    app.all("*", (context) =>
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
    [
      new IdempotencyConflictError({ key: "same-key" }),
      409,
      "idempotency_conflict",
      "Idempotency key was already used for a different request.",
    ],
    [new ListNotFoundError({ listId: "missing" }), 404, "not_found", "List not found."],
    [new NotFoundError({ message: "Thing not found." }), 404, "not_found", "Thing not found."],
    [
      new EmptyRecipientSetError({ reason: "No recipients." }),
      422,
      "empty_recipient_set",
      "No recipients.",
    ],
    [
      new RecipientLimitExceededError({ limit: 5000 }),
      422,
      "recipient_limit_exceeded",
      "Recipient source exceeds the maximum of 5000 recipients.",
    ],
  ] as const)("maps %o", async (error, status, code, message) => {
    const response = await respondWith(Effect.fail(error));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code, message } });
  });

  it.each([
    [
      new DatabaseError({
        cause: new Error("secret sql detail"),
        operation: "sending:attempt:succeed",
      }),
      "sending",
    ],
    [
      new DatabaseError({
        cause: new Error("secret sql detail"),
        operation: "sending:operation-sentinel",
      }),
      "sending",
    ],
    [
      new AuthError({ cause: new Error("secret auth detail"), operation: "getSession" }),
      "getSession",
    ],
  ] as const)(
    "maps infrastructure failure %o to fixed formatted metadata",
    async (error, expectedOperation) => {
      const logs: CapturedLog[] = [];
      const response = await respondWith(Effect.fail(error), logs);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: { code: "internal_error", message: "Internal error." },
      });
      const errors = logs.filter((entry) => formattedLog(entry).includes("request failed"));
      expect(errors).toHaveLength(1);
      expect(formattedLog(errors[0]!)).toContain(`"operation":"${expectedOperation}"`);
      expect(formattedLogs(logs)).not.toContain("secret");
      expect(formattedLogs(logs)).not.toContain("operation-sentinel");
    },
  );

  it("formats a fixed fallback for a known-class proxy whose operation getter throws", async () => {
    const failure = new Proxy(
      new DatabaseError({ cause: "proxy-cause-sentinel", operation: "sending:proxy-sentinel" }),
      {
        get: (target, property, receiver) => {
          if (property === "operation") throw new Error("throwing-operation-sentinel");
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const logs: CapturedLog[] = [];

    const response = await respondWith(Effect.fail(failure), logs);

    expect(response.status).toBe(500);
    const formatted = formattedLogs(logs);
    expect(formatted).toContain('"failureTag":"Unknown"');
    for (const secret of [
      "proxy-cause-sentinel",
      "proxy-sentinel",
      "throwing-operation-sentinel",
    ]) {
      expect(formatted).not.toContain(secret);
    }
  });

  it("maps defects to one structured sanitized 500 log", async () => {
    const logs: CapturedLog[] = [];
    const response = await respondWith(
      Effect.die({ _tag: "defect-tag-sentinel", message: "unexpected crash detail" }),
      logs,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Internal error." },
    });
    const errors = logs.filter((entry) => formattedLog(entry).includes("request failed"));
    expect(errors).toHaveLength(1);
    expect(formattedLog(errors[0]!)).toContain('"defectType":"Unknown"');
    expect(formattedLogs(logs)).not.toContain("defect-tag-sentinel");
    expect(formattedLogs(logs)).not.toContain("unexpected crash detail");
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

function formattedLog(entry: CapturedLog): string {
  return Logger.formatJson.log(entry);
}

function formattedLogs(entries: readonly CapturedLog[]): string {
  return entries.map(formattedLog).join("\n");
}
