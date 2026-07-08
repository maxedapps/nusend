import { Effect, Option } from "effect";

import type { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { EmailSendingConfig, type EmailSendingConfigService } from "../services/email-transport.ts";
import { UnsubscribeConfig, type UnsubscribeConfigService } from "../unsubscribe/config.ts";
import type { DeliveryContext } from "./schema.ts";

export type PolicyDecision =
  | { readonly kind: "Allow" }
  | { readonly kind: "BlockPermanent"; readonly message: string; readonly status: "suppressed" }
  | { readonly kind: "BlockRetryable"; readonly message: string };

export const missingUnsubscribeConfigMessage =
  "Marketing sending requires unsubscribe configuration.";
export const missingMarketingConfigurationSetMessage =
  "Marketing sending requires an SES marketing configuration set.";

export function runPolicyGates(
  context: DeliveryContext,
): Effect.Effect<
  PolicyDecision,
  DatabaseError,
  DatabaseService | EmailSendingConfigService | UnsubscribeConfigService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const isMarketing = context.mailing.purpose === "marketing";
    const suppression = yield* db.get<{ ok: number }>(
      "sending:policy:suppression",
      `SELECT 1 AS ok
       FROM suppressions
       WHERE email = $email COLLATE NOCASE
         AND ${
           isMarketing
             ? "(scope IN ('all', 'marketing') OR (scope = 'list' AND list_id = $listId))"
             : "scope = 'all'"
         }
       LIMIT 1;`,
      isMarketing
        ? { email: context.delivery.email, listId: context.mailing.listId }
        : { email: context.delivery.email },
    );

    if (suppression) {
      return {
        kind: "BlockPermanent" as const,
        message: isMarketing
          ? "Recipient is suppressed for marketing."
          : "Recipient is globally suppressed.",
        status: "suppressed" as const,
      };
    }

    if (isMarketing) {
      const unsubscribe = yield* UnsubscribeConfig;
      if (Option.isNone(unsubscribe.config)) {
        return { kind: "BlockRetryable" as const, message: missingUnsubscribeConfigMessage };
      }

      const sending = yield* EmailSendingConfig;
      if (sending.marketingConfigurationSet === null) {
        return {
          kind: "BlockRetryable" as const,
          message: missingMarketingConfigurationSetMessage,
        };
      }
    }

    return { kind: "Allow" as const };
  });
}
