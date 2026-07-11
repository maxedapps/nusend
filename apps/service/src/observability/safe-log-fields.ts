import { Cause } from "effect";

import { AuthError, DatabaseError } from "../errors.ts";
import { SnsConfirmationError } from "../ses/errors.ts";

export type SafeRequestMeta = {
  readonly method: string;
  readonly path: string;
};

const safeHttpMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const safeStaticPaths = new Set([
  "/cli/activate",
  "/health",
  "/health/db",
  "/api/api-keys",
  "/api/contacts",
  "/api/device-authorizations",
  "/api/device-authorizations/token",
  "/api/lists",
  "/api/mailings",
  "/api/me",
  "/api/operations/deliveries",
  "/api/operations/ses/events",
  "/api/operations/ses/readiness",
  "/api/operations/ses/summary",
  "/api/suppressions",
  "/api/webhooks/aws/sns/ses",
]);
const safeOperationCategories = [
  ["apiKeys:", "apiKeys"],
  ["auth:", "auth"],
  ["contacts:", "contacts"],
  ["deviceAuth:", "deviceAuth"],
  ["lists:", "lists"],
  ["mailings:", "mailings"],
  ["operations:", "operations"],
  ["queue:", "queue"],
  ["sending:", "sending"],
  ["ses:", "ses"],
  ["sns:", "sns"],
  ["suppressions:", "suppressions"],
  ["unsubscribe:", "unsubscribe"],
  ["worker-runs:", "worker-runs"],
] as const;
const safeAuthOperations = new Set(["decodeSession", "getSession"]);

export function sanitizedLogPath(path: string): string {
  try {
    if (path.startsWith("/unsubscribe/")) return "/unsubscribe/:token";
    if (path.startsWith("/api/auth/")) return "/api/auth/:route";
    if (/^\/api\/(?:api-keys|contacts|lists|mailings|suppressions)\/[^/]+$/.test(path)) {
      return `${path.slice(0, path.lastIndexOf("/"))}/:id`;
    }
    return safeStaticPaths.has(path) ? path : "/unrecognized";
  } catch {
    return "/unrecognized";
  }
}

export function safeRequestMeta(request: Request): SafeRequestMeta {
  try {
    const method = request.method.toUpperCase();
    return {
      method: safeHttpMethods.has(method) ? method : "UNKNOWN",
      path: sanitizedLogPath(new URL(request.url).pathname),
    };
  } catch {
    return { method: "UNKNOWN", path: "/unrecognized" };
  }
}

export function safeLogFields(
  cause: Cause.Cause<unknown>,
  requestMeta?: SafeRequestMeta,
): Readonly<Record<string, string>> {
  const base: Record<string, string> = { event: "internal_failure" };
  if (requestMeta !== undefined) {
    try {
      const method = requestMeta.method;
      base.method = safeHttpMethods.has(method) ? method : "UNKNOWN";
      base.path = sanitizedLogPath(requestMeta.path);
    } catch {
      base.method = "UNKNOWN";
      base.path = "/unrecognized";
    }
  }
  try {
    const reasons = cause.reasons;
    if (reasons.length !== 1) return { ...base, failureTag: "Multiple" };

    const reason = reasons[0]!;
    if (Cause.isFailReason(reason)) return { ...base, ...safeFailureFields(reason.error) };
    if (Cause.isDieReason(reason)) return { ...base, defectType: safeDefectType(reason.defect) };
    if (Cause.isInterruptReason(reason)) return { ...base, defectType: "Interrupted" };
    return { ...base, defectType: "Unknown" };
  } catch {
    return { ...base, defectType: "Unknown" };
  }
}

function safeFailureFields(failure: unknown): Readonly<Record<string, string>> {
  try {
    if (safeInstanceOf(failure, AuthError)) {
      return {
        failureTag: "AuthError",
        operation: safeAuthOperations.has(failure.operation) ? failure.operation : "unknown",
      };
    }
    if (safeInstanceOf(failure, DatabaseError)) {
      return {
        failureTag: "DatabaseError",
        operation: safeDatabaseOperation(failure.operation),
      };
    }
    if (safeInstanceOf(failure, SnsConfirmationError)) {
      return { failureTag: "SnsConfirmationError" };
    }
  } catch {
    // Known-class proxies with hostile property access are not trusted metadata.
  }
  return { failureTag: "Unknown" };
}

function safeDefectType(defect: unknown): string {
  try {
    if (safeInstanceOf(defect, TypeError)) return "TypeError";
    if (safeInstanceOf(defect, RangeError)) return "RangeError";
    if (safeInstanceOf(defect, ReferenceError)) return "ReferenceError";
    if (safeInstanceOf(defect, SyntaxError)) return "SyntaxError";
    if (safeInstanceOf(defect, Error)) return "Error";
    if (defect === null) return "Null";
    switch (typeof defect) {
      case "undefined":
        return "Undefined";
      case "string":
        return "String";
      case "number":
        return "Number";
      case "boolean":
        return "Boolean";
      case "bigint":
        return "BigInt";
      case "symbol":
        return "Symbol";
      default:
        return "Unknown";
    }
  } catch {
    return "Unknown";
  }
}

function safeDatabaseOperation(operation: string): string {
  try {
    for (const [prefix, category] of safeOperationCategories) {
      if (operation.startsWith(prefix)) return category;
    }
  } catch {
    // Hostile operation getters/values are not trusted metadata.
  }
  return "unknown";
}

function safeInstanceOf<T>(
  value: unknown,
  constructor: abstract new (...args: never[]) => T,
): value is T {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}
