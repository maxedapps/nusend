import { Effect } from "effect";

import type { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import type { DeliveryContext } from "./schema.ts";

export type PolicyDecision =
  | { readonly kind: "Allow" }
  | { readonly kind: "Block"; readonly message: string; readonly status: "failed" | "suppressed" };

export const marketingBlockedMessage = "Marketing sending requires unsubscribe support.";

export function runPolicyGates(
  context: DeliveryContext,
): Effect.Effect<PolicyDecision, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    if (context.mailing.purpose === "marketing") {
      return {
        kind: "Block" as const,
        message: marketingBlockedMessage,
        status: "failed" as const,
      };
    }

    const db = yield* Database;
    const suppression = yield* db.get<{ ok: number }>(
      "sending:policy:suppression",
      `SELECT 1 AS ok
       FROM suppressions
       WHERE email = $email COLLATE NOCASE
         AND scope = 'all'
       LIMIT 1;`,
      { email: context.delivery.email },
    );

    if (suppression) {
      return {
        kind: "Block" as const,
        message: "Recipient is globally suppressed.",
        status: "suppressed" as const,
      };
    }

    return { kind: "Allow" as const };
  });
}
