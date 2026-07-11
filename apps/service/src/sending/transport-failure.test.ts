import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import { EmailTransportError } from "../services/email-transport.ts";
import { classifyTransportFailure } from "./transport-failure.ts";

const unexpected = {
  explicit: false,
  kind: "ambiguous",
  message: "Unexpected email transport failure after dispatch.",
};

function transportError(kind: "ambiguous" | "permanent" | "retryable") {
  return new EmailTransportError({
    cause: new Error("provider-cause-sentinel"),
    kind,
    operation: "provider-operation-sentinel",
  });
}

function reason<E>(cause: Cause.Cause<E>): Cause.Reason<E> {
  return cause.reasons[0]!;
}

describe("classifyTransportFailure", () => {
  it.each(["ambiguous", "permanent", "retryable"] as const)(
    "preserves multiple uniformly typed %s reasons",
    (kind) => {
      const cause = Cause.fromReasons([
        reason(Cause.fail(transportError(kind))),
        reason(Cause.fail(transportError(kind))),
      ]);

      expect(classifyTransportFailure(cause)).toEqual({
        explicit: true,
        kind,
        message: `Email transport ${kind} failure.`,
      });
    },
  );

  const hostileProxy = new Proxy(transportError("retryable"), {
    getPrototypeOf() {
      throw new Error("provider-prototype-sentinel");
    },
  });
  const hostileGetter = transportError("retryable");
  Object.defineProperty(hostileGetter, "kind", {
    get() {
      throw new Error("provider-kind-sentinel");
    },
  });

  it.each([
    ["empty", Cause.empty],
    ["die", Cause.die(new Error("provider-die-sentinel"))],
    ["interrupt", Cause.interrupt(1)],
    ["untyped fail", Cause.fail({ providerSecret: "provider-untyped-sentinel" })],
    [
      "mixed typed and untyped fails",
      Cause.fromReasons<unknown>([
        reason(Cause.fail(transportError("retryable"))),
        reason(Cause.fail({ providerSecret: "provider-mixed-sentinel" })),
      ]),
    ],
    [
      "conflicting typed kinds",
      Cause.fromReasons([
        reason(Cause.fail(transportError("retryable"))),
        reason(Cause.fail(transportError("permanent"))),
      ]),
    ],
    ["hostile instanceof proxy", Cause.fail(hostileProxy)],
    ["hostile kind getter", Cause.fail(hostileGetter)],
  ] as const)("maps %s to fixed terminal ambiguity", (_label, cause) => {
    const decision = classifyTransportFailure(cause);
    expect(decision).toEqual(unexpected);
    expect(JSON.stringify(decision)).not.toContain("provider-");
  });
});
