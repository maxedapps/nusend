import { Effect, Layer } from "effect";

import {
  EmailSendingConfig,
  EmailTransport,
  EmailTransportError,
  type EmailSendingConfigService,
  type EmailTransportService,
  type PreparedEmail,
  type SendResult,
} from "../services/email-transport.ts";

export type FakeTransportOutcome =
  | { readonly kind: "Fail"; readonly error: EmailTransportError }
  | { readonly kind: "Succeed"; readonly result: SendResult };

export type FakeTransportState = {
  readonly sent: PreparedEmail[];
};

export function fakeEmailTransportLayer(outcomes: readonly FakeTransportOutcome[] = []): {
  readonly layer: Layer.Layer<EmailTransportService>;
  readonly state: FakeTransportState;
} {
  const sent: PreparedEmail[] = [];
  let index = 0;

  return {
    layer: Layer.succeed(EmailTransport)({
      send: (email) =>
        Effect.sync(() => {
          sent.push(email);
          const outcome = outcomes[index] ?? {
            kind: "Succeed" as const,
            result: { messageId: `fake-message-${index + 1}` },
          };
          index += 1;
          return outcome;
        }).pipe(
          Effect.flatMap((outcome) =>
            outcome.kind === "Succeed"
              ? Effect.succeed(outcome.result)
              : Effect.fail(outcome.error),
          ),
        ),
    }),
    state: { sent },
  };
}

export function fakeSendingConfigLayer(
  overrides: Partial<EmailSendingConfigService> = {},
): Layer.Layer<EmailSendingConfigService> {
  return Layer.succeed(EmailSendingConfig)({
    fromEmail: "sender@example.com",
    marketingConfigurationSet: null,
    region: "us-east-1",
    requestTimeoutMs: 30_000,
    transactionalConfigurationSet: "txn-config",
    ...overrides,
  });
}
