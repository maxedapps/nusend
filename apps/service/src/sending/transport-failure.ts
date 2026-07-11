import { Cause } from "effect";

import { EmailTransportError } from "../services/email-transport.ts";

export type TransportFailureDecision =
  | {
      readonly kind: "permanent";
      readonly message: "Email transport permanent failure.";
      readonly explicit: true;
    }
  | {
      readonly kind: "retryable";
      readonly message: "Email transport retryable failure.";
      readonly explicit: true;
    }
  | {
      readonly kind: "ambiguous";
      readonly message: "Email transport ambiguous failure.";
      readonly explicit: true;
    }
  | {
      readonly kind: "ambiguous";
      readonly message: "Unexpected email transport failure after dispatch.";
      readonly explicit: false;
    };

const unexpected: TransportFailureDecision = {
  explicit: false,
  kind: "ambiguous",
  message: "Unexpected email transport failure after dispatch.",
};

export function classifyTransportFailure(cause: Cause.Cause<unknown>): TransportFailureDecision {
  if (cause.reasons.length === 0) return unexpected;

  let uniformKind: "ambiguous" | "permanent" | "retryable" | undefined;
  for (const reason of cause.reasons) {
    if (Cause.isDieReason(reason) || Cause.isInterruptReason(reason)) return unexpected;
    if (!Cause.isFailReason(reason)) return unexpected;

    const kind = recognizedTransportKind(reason.error);
    if (kind === undefined) return unexpected;
    if (uniformKind !== undefined && uniformKind !== kind) return unexpected;
    uniformKind = kind;
  }

  switch (uniformKind) {
    case "permanent":
      return { explicit: true, kind: "permanent", message: "Email transport permanent failure." };
    case "retryable":
      return { explicit: true, kind: "retryable", message: "Email transport retryable failure." };
    case "ambiguous":
      return { explicit: true, kind: "ambiguous", message: "Email transport ambiguous failure." };
    default:
      return unexpected;
  }
}

function recognizedTransportKind(
  value: unknown,
): "ambiguous" | "permanent" | "retryable" | undefined {
  try {
    if (!(value instanceof EmailTransportError)) return undefined;
    const kind = value.kind;
    return kind === "ambiguous" || kind === "permanent" || kind === "retryable" ? kind : undefined;
  } catch {
    return undefined;
  }
}
