import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import { AuthError, DatabaseError } from "../errors.ts";
import { SnsConfirmationError } from "../ses/errors.ts";
import { safeLogFields, safeRequestMeta, sanitizedLogPath } from "./safe-log-fields.ts";

const sentinel = "unsafe-metadata-sentinel";

class SentinelError extends Error {
  readonly _tag = sentinel;
}

describe("safeLogFields", () => {
  it.each([
    { defect: new TypeError(sentinel), defectType: "TypeError" },
    { defect: new RangeError(sentinel), defectType: "RangeError" },
    { defect: new ReferenceError(sentinel), defectType: "ReferenceError" },
    { defect: new SyntaxError(sentinel), defectType: "SyntaxError" },
    { defect: new SentinelError(sentinel), defectType: "Error" },
    { defect: undefined, defectType: "Undefined" },
    { defect: "string-defect-sentinel", defectType: "String" },
    { defect: 42, defectType: "Number" },
    { defect: true, defectType: "Boolean" },
    { defect: 1n, defectType: "BigInt" },
    { defect: Symbol(sentinel), defectType: "Symbol" },
    { defect: null, defectType: "Null" },
  ] as const)("maps a defect to the fixed $defectType category", ({ defect, defectType }) => {
    expect(safeLogFields(Cause.die(defect))).toEqual({
      defectType,
      event: "internal_failure",
    });
  });

  it("maps hostile failure and defect values to fixed fields without invoking metadata getters", () => {
    const hostileObject = Object.create(null);
    for (const key of ["_tag", "constructor", "message", "stack", "cause"]) {
      Object.defineProperty(hostileObject, key, {
        enumerable: true,
        get: () => {
          throw new Error(`${sentinel}-${key}`);
        },
      });
    }
    Object.defineProperty(hostileObject, Symbol.toStringTag, {
      get: () => {
        throw new Error(`${sentinel}-symbol`);
      },
    });
    const hostileProxy = new Proxy(hostileObject, {
      getPrototypeOf: () => {
        throw new Error(`${sentinel}-prototype`);
      },
    });

    const fields = [
      safeLogFields(Cause.fail(hostileObject)),
      safeLogFields(Cause.fail(hostileProxy)),
      safeLogFields(Cause.die(hostileObject)),
      safeLogFields(Cause.die(hostileProxy)),
    ];

    expect(fields).toEqual([
      { event: "internal_failure", failureTag: "Unknown" },
      { event: "internal_failure", failureTag: "Unknown" },
      { defectType: "Unknown", event: "internal_failure" },
      { defectType: "Unknown", event: "internal_failure" },
    ]);
    expect(JSON.stringify(fields)).not.toContain(sentinel);
  });

  it.each([
    [
      "AuthError/getSession",
      new AuthError({ cause: sentinel, operation: "getSession" }),
      "AuthError",
      "getSession",
    ],
    [
      "AuthError/unsafe operation",
      new AuthError({ cause: sentinel, operation: sentinel }),
      "AuthError",
      "unknown",
    ],
    [
      "DatabaseError/sending operation",
      new DatabaseError({ cause: sentinel, operation: "sending:attempt:succeed" }),
      "DatabaseError",
      "sending",
    ],
    [
      "DatabaseError/sending prefix with unsafe suffix",
      new DatabaseError({ cause: sentinel, operation: `sending:${sentinel}` }),
      "DatabaseError",
      "sending",
    ],
    [
      "DatabaseError/unsafe operation",
      new DatabaseError({ cause: sentinel, operation: sentinel }),
      "DatabaseError",
      "unknown",
    ],
    [
      "SnsConfirmationError/no operation",
      new SnsConfirmationError({ cause: sentinel, reason: sentinel }),
      "SnsConfirmationError",
      undefined,
    ],
  ] as const)(
    "allowlists known internal failure metadata (%s)",
    (_label, failure, failureTag, operation) => {
      const fields = safeLogFields(Cause.fail(failure));

      expect(fields.failureTag).toBe(failureTag);
      expect(fields.operation).toBe(operation);
      expect(JSON.stringify(fields)).not.toContain(sentinel);
    },
  );

  it("falls back without throwing for a known-class proxy with a hostile operation getter", () => {
    const failure = new Proxy(
      new DatabaseError({ cause: sentinel, operation: "sending:attempt:succeed" }),
      {
        get: (target, property, receiver) => {
          if (property === "operation") throw new Error(`${sentinel}-operation`);
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const fields = safeLogFields(Cause.fail(failure));
    expect(fields).toEqual({ event: "internal_failure", failureTag: "Unknown" });
    expect(JSON.stringify(fields)).not.toContain(sentinel);
  });

  it("uses one fixed category for mixed or multiple reasons", () => {
    const cause = Cause.fromReasons([
      Cause.fail(sentinel).reasons[0]!,
      Cause.die(sentinel).reasons[0]!,
    ]);

    expect(safeLogFields(cause)).toEqual({ event: "internal_failure", failureTag: "Multiple" });
  });
});

describe("safe request metadata", () => {
  it.each(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])(
    "retains the allowed %s method literal",
    (method) => {
      expect(safeRequestMeta(new Request("http://localhost/health", { method }))).toEqual({
        method,
        path: "/health",
      });
    },
  );

  it.each([
    [
      "http://localhost/unsubscribe/token-sentinel?query=query-sentinel",
      "GET",
      "/unsubscribe/:token",
    ],
    ["http://localhost/api/auth/sign-in/provider-sentinel", "POST", "/api/auth/:route"],
    ["http://localhost/api/contacts/resource-sentinel", "PATCH", "/api/contacts/:id"],
    ["http://localhost/api/mailings?query=query-sentinel", "GET", "/api/mailings"],
    ["http://localhost/unknown/body-sentinel", "CUSTOM", "/unrecognized"],
  ])("sanitizes %s", (url, method, path) => {
    expect(safeRequestMeta(new Request(url, { method }))).toEqual({
      method: method === "CUSTOM" ? "UNKNOWN" : method,
      path,
    });
  });

  it("falls back for hostile request and path getters", () => {
    const request = new Proxy(new Request("http://localhost/health"), {
      get: () => {
        throw new Error(sentinel);
      },
    });
    const path = new Proxy(
      {},
      {
        get: () => {
          throw new Error(sentinel);
        },
      },
    ) as unknown as string;

    expect(safeRequestMeta(request)).toEqual({ method: "UNKNOWN", path: "/unrecognized" });
    expect(sanitizedLogPath(path)).toBe("/unrecognized");
  });
});
