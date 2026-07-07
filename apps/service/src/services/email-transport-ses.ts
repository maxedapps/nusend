import { SESv2Client, SendEmailCommand, type SendEmailCommandOutput } from "@aws-sdk/client-sesv2";
import { Effect, Layer } from "effect";

import { isSafeSesTag } from "../sending/prepare.ts";
import {
  EmailSendingConfig,
  EmailTransport,
  EmailTransportError,
  type EmailSendingConfigService,
  type EmailTransportService,
  type PreparedEmail,
} from "./email-transport.ts";

export type SesSender = {
  readonly send: (
    command: SendEmailCommand,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<SendEmailCommandOutput>;
};

export const EmailTransportSesLive: Layer.Layer<
  EmailTransportService,
  never,
  EmailSendingConfigService
> = Layer.effect(
  EmailTransport,
  Effect.map(EmailSendingConfig, (config) =>
    makeSesEmailTransport(new SESv2Client({ region: config.region }), config.requestTimeoutMs),
  ),
);

export function makeSesEmailTransport(
  sender: SesSender,
  requestTimeoutMs: number,
): EmailTransportService {
  return {
    send: (email) =>
      Effect.tryPromise({
        try: () =>
          sender.send(toSendEmailCommand(email), { abortSignal: timeoutSignal(requestTimeoutMs) }),
        catch: (cause) => classifySesError(cause),
      }).pipe(
        Effect.flatMap((output) =>
          output.MessageId
            ? Effect.succeed({ messageId: output.MessageId })
            : Effect.fail(new EmailTransportError({ kind: "ambiguous", operation: "ses:send" })),
        ),
      ),
  };
}

export function toSendEmailCommand(email: PreparedEmail): SendEmailCommand {
  for (const [name, value] of Object.entries(email.tags)) {
    if (!isSafeSesTag(name, value)) {
      throw new EmailTransportError({ kind: "permanent", operation: "ses:validate-tag" });
    }
  }

  for (const [name, value] of Object.entries(email.headers)) {
    if (!isSafeCustomHeader(name, value)) {
      throw new EmailTransportError({ kind: "permanent", operation: "ses:validate-header" });
    }
  }

  return new SendEmailCommand({
    ConfigurationSetName: email.configurationSetName ?? undefined,
    Content: {
      Simple: {
        Body: {
          Html: { Data: email.html, Charset: "UTF-8" },
          Text: email.text ? { Data: email.text, Charset: "UTF-8" } : undefined,
        },
        Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value })),
        Subject: { Data: email.subject, Charset: "UTF-8" },
      },
    },
    Destination: { ToAddresses: [email.to] },
    EmailTags: Object.entries(email.tags).map(([Name, Value]) => ({ Name, Value })),
    FromEmailAddress: email.from,
  });
}

export function classifySesError(cause: unknown): EmailTransportError {
  if (cause instanceof EmailTransportError) return cause;

  const name = getErrorName(cause);

  if (name === "AbortError" || name === "TimeoutError" || name === "RequestTimeout") {
    return new EmailTransportError({ cause, kind: "ambiguous", operation: "ses:send" });
  }

  const code = getErrorCode(cause);

  if ((name && retryableErrors.has(name)) || (code && retryableErrors.has(code))) {
    return new EmailTransportError({ cause, kind: "retryable", operation: "ses:send" });
  }

  if (isRetryableHttpStatus(cause)) {
    return new EmailTransportError({ cause, kind: "retryable", operation: "ses:send" });
  }

  if (name && permanentErrors.has(name)) {
    return new EmailTransportError({ cause, kind: "permanent", operation: "ses:send" });
  }

  return new EmailTransportError({ cause, kind: "ambiguous", operation: "ses:send" });
}

const managedHeaders = new Set([
  "bcc",
  "cc",
  "content-transfer-encoding",
  "content-type",
  "date",
  "from",
  "message-id",
  "mime-version",
  "reply-to",
  "return-path",
  "sender",
  "subject",
  "to",
]);

function isSafeCustomHeader(name: string, value: string): boolean {
  if (name.length < 1 || name.length > 126) return false;
  if (value.length > 995) return false;
  if (name.length + value.length > 996) return false;
  if (managedHeaders.has(name.toLowerCase())) return false;

  return isHeaderNameAscii(name) && isHeaderValueAscii(value);
}

function isHeaderNameAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 33 || code > 126 || code === 58) return false;
  }

  return true;
}

function isHeaderValueAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code > 126) return false;
  }

  return true;
}

const retryableErrors = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "InternalFailure",
  "InternalServerError",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "ThrottlingException",
  "TooManyRequestsException",
]);
const permanentErrors = new Set([
  "AccountSuspendedException",
  "BadRequestException",
  "MailFromDomainNotVerifiedException",
  "MessageRejected",
  "NotFoundException",
  "SendingPausedException",
]);

function getErrorName(cause: unknown): string | null {
  return typeof cause === "object" && cause !== null && "name" in cause
    ? String((cause as { name: unknown }).name)
    : null;
}

function getErrorCode(cause: unknown): string | null {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : null;
}

function isRetryableHttpStatus(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("$metadata" in cause)) return false;

  const metadata = (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === "number" && metadata.httpStatusCode >= 500;
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
}
