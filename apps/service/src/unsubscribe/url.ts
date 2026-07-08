import { Effect, Option } from "effect";

import { SendPreparationError } from "../sending/schema.ts";
import { UnsubscribeConfig, type UnsubscribeConfigService } from "./config.ts";
import { signUnsubscribeToken } from "./token.ts";

export function buildUnsubscribeUrl(
  deliveryId: string,
): Effect.Effect<string, SendPreparationError, UnsubscribeConfigService> {
  return Effect.gen(function* () {
    const settings = yield* UnsubscribeConfig;
    if (Option.isNone(settings.config)) {
      return yield* Effect.fail(
        new SendPreparationError({
          message: "Marketing sending requires unsubscribe configuration.",
        }),
      );
    }

    const token = signUnsubscribeToken(deliveryId, settings.config.value.currentSecret);
    return `${settings.config.value.publicBaseUrl}/unsubscribe/${token}`;
  });
}
