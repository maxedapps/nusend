import { Context, Data, Effect, Layer } from "effect";

export type PreparedEmail = {
  readonly configurationSetName: string | null;
  readonly from: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly html: string;
  readonly subject: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly text: string | null;
  readonly to: string;
};

export type SendResult = {
  readonly messageId: string;
};

export class EmailTransportError extends Data.TaggedError("EmailTransportError")<{
  readonly cause?: unknown;
  readonly kind: "ambiguous" | "permanent" | "retryable";
  readonly operation: string;
}> {}

export interface EmailTransportService {
  readonly send: (email: PreparedEmail) => Effect.Effect<SendResult, EmailTransportError>;
}

export const EmailTransport = Context.Service<EmailTransportService>("nusend/EmailTransport");

export type EmailSendingConfigService = {
  readonly fromEmail: string;
  readonly marketingConfigurationSet: string | null;
  readonly region: string;
  readonly requestTimeoutMs: number;
  readonly transactionalConfigurationSet: string | null;
};

export const EmailSendingConfig = Context.Service<EmailSendingConfigService>(
  "nusend/EmailSendingConfig",
);

export function EmailSendingConfigLive(
  config: EmailSendingConfigService,
): Layer.Layer<EmailSendingConfigService> {
  return Layer.succeed(EmailSendingConfig)(config);
}
