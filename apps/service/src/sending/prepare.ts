import { Effect } from "effect";

import {
  EmailSendingConfig,
  type EmailSendingConfigService,
  type PreparedEmail,
} from "../services/email-transport.ts";
import type { DeliveryContext, RenderedEmail } from "./schema.ts";
import { SendPreparationError } from "./schema.ts";

const sesTagNamePattern = /^[A-Za-z0-9_-]{1,256}$/;
const sesTagValuePattern = /^[A-Za-z0-9_-]{1,256}$/;

export function prepareEmail(
  context: DeliveryContext,
  rendered: RenderedEmail,
): Effect.Effect<PreparedEmail, SendPreparationError, EmailSendingConfigService> {
  return Effect.gen(function* () {
    const config = yield* EmailSendingConfig;
    const tags = {
      delivery_id: context.delivery.id,
      mailing_id: context.mailing.id,
      purpose: context.mailing.purpose,
    };
    yield* validatePreparedTags(tags);

    return {
      configurationSetName:
        context.mailing.purpose === "transactional"
          ? config.transactionalConfigurationSet
          : config.marketingConfigurationSet,
      from: config.fromEmail,
      headers: {},
      html: rendered.html,
      subject: rendered.subject,
      tags,
      text: rendered.text,
      to: context.delivery.email,
    };
  });
}

export function validatePreparedTags(
  tags: Record<string, string>,
): Effect.Effect<void, SendPreparationError> {
  for (const [name, value] of Object.entries(tags)) {
    if (!sesTagNamePattern.test(name) || !sesTagValuePattern.test(value)) {
      return Effect.fail(new SendPreparationError({ message: `SES tag is invalid: ${name}.` }));
    }
  }

  return Effect.void;
}

export function isSafeSesTag(name: string, value: string): boolean {
  return sesTagNamePattern.test(name) && sesTagValuePattern.test(value);
}
