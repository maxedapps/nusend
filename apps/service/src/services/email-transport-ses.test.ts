import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { PreparedEmail } from "./email-transport.ts";
import {
  classifySesError,
  makeSesClient,
  makeSesEmailTransport,
  toSendEmailCommand,
} from "./email-transport-ses.ts";

const prepared: PreparedEmail = {
  configurationSetName: "config-set",
  from: "sender@example.com",
  headers: { "List-Unsubscribe": "<https://example.com/unsubscribe>" },
  html: "<p>Hello</p>",
  subject: "Hello",
  tags: { delivery_id: "delivery_1", mailing_id: "mailing_1", purpose: "transactional" },
  text: "Hello",
  to: "user@example.com",
};

describe("SES email transport", () => {
  it("maps prepared email to SendEmailCommand", () => {
    const command = toSendEmailCommand(prepared);

    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input).toEqual({
      ConfigurationSetName: "config-set",
      Content: {
        Simple: {
          Body: {
            Html: { Charset: "UTF-8", Data: "<p>Hello</p>" },
            Text: { Charset: "UTF-8", Data: "Hello" },
          },
          Headers: [{ Name: "List-Unsubscribe", Value: "<https://example.com/unsubscribe>" }],
          Subject: { Charset: "UTF-8", Data: "Hello" },
        },
      },
      Destination: { ToAddresses: ["user@example.com"] },
      EmailTags: [
        { Name: "delivery_id", Value: "delivery_1" },
        { Name: "mailing_id", Value: "mailing_1" },
        { Name: "purpose", Value: "transactional" },
      ],
      FromEmailAddress: "sender@example.com",
    });
  });

  it("returns the SES message id", async () => {
    const sent: SendEmailCommand[] = [];
    const transport = makeSesEmailTransport(
      {
        send: async (command) => {
          sent.push(command);
          return { MessageId: "ses-message-1", $metadata: {} };
        },
      },
      30_000,
    );

    await expect(Effect.runPromise(transport.send(prepared))).resolves.toEqual({
      messageId: "ses-message-1",
    });
    expect(sent[0].input.FromEmailAddress).toBe("sender@example.com");
  });

  it("passes an abort signal to the SES sender", async () => {
    let capturedOptions: { abortSignal?: AbortSignal } | undefined;
    const transport = makeSesEmailTransport(
      {
        send: async (_command, options) => {
          capturedOptions = options;
          return { MessageId: "ses-message-1", $metadata: {} };
        },
      },
      30_000,
    );

    await expect(Effect.runPromise(transport.send(prepared))).resolves.toEqual({
      messageId: "ses-message-1",
    });
    expect(capturedOptions).toBeDefined();
    if (typeof AbortSignal.timeout === "function") {
      expect(capturedOptions?.abortSignal).toBeInstanceOf(AbortSignal);
    }
  });

  it("maps timeout-shaped send rejection to ambiguous through transport.send", async () => {
    const transport = makeSesEmailTransport(
      {
        send: async () => Promise.reject(sesError({ name: "TimeoutError" })),
      },
      30_000,
    );

    await expect(Effect.runPromise(transport.send(prepared))).rejects.toMatchObject({
      _tag: "EmailTransportError",
      kind: "ambiguous",
      operation: "ses:send",
    });
  });

  it("maps a ServiceUnavailableException with HTTP 503 to ambiguous through transport.send", async () => {
    const transport = makeSesEmailTransport(
      {
        send: async () =>
          Promise.reject(sesError({ name: "ServiceUnavailableException", status: 503 })),
      },
      30_000,
    );

    await expect(Effect.runPromise(transport.send(prepared))).rejects.toMatchObject({
      _tag: "EmailTransportError",
      kind: "ambiguous",
      operation: "ses:send",
    });
  });

  it.each([
    ["name", "InternalFailure"],
    ["code", "InternalFailure"],
    ["name", "InternalServerError"],
    ["code", "InternalServerError"],
    ["name", "ServiceUnavailable"],
    ["code", "ServiceUnavailable"],
    ["name", "ServiceUnavailableException"],
    ["code", "ServiceUnavailableException"],
  ] as const)("classifies SES provider %s %s as ambiguous", (signal, value) => {
    const cause = signal === "name" ? sesError({ name: value }) : sesError({ code: value });
    expect(classifySesError(cause).kind).toBe("ambiguous");
  });

  it.each([500, 503, 599])("classifies SES metadata HTTP status %i as ambiguous", (status) => {
    expect(classifySesError(sesError({ status })).kind).toBe("ambiguous");
  });

  it.each([499, 600])(
    "keeps pre-connect code retryable with out-of-range HTTP status %i",
    (status) => {
      expect(classifySesError(sesError({ code: "ECONNREFUSED", status })).kind).toBe("retryable");
    },
  );

  it.each(["AbortError", "TimeoutError", "RequestTimeout"])(
    "classifies timeout/abort name %s as ambiguous",
    (name) => {
      expect(classifySesError(sesError({ name })).kind).toBe("ambiguous");
    },
  );

  it.each([
    ["name", "ECONNREFUSED"],
    ["code", "ECONNREFUSED"],
    ["name", "ENETUNREACH"],
    ["code", "ENETUNREACH"],
    ["name", "ENOTFOUND"],
    ["code", "ENOTFOUND"],
    ["name", "EAI_AGAIN"],
    ["code", "EAI_AGAIN"],
  ] as const)("classifies pre-connect %s %s as retryable", (signal, value) => {
    const cause = signal === "name" ? sesError({ name: value }) : sesError({ code: value });
    expect(classifySesError(cause).kind).toBe("retryable");
  });

  it.each([
    ["name", "ThrottlingException"],
    ["code", "ThrottlingException"],
    ["name", "TooManyRequestsException"],
    ["code", "TooManyRequestsException"],
    ["name", "LimitExceededException"],
    ["code", "LimitExceededException"],
    ["name", "SendingPausedException"],
    ["code", "SendingPausedException"],
  ] as const)("classifies provider refusal %s %s as retryable", (signal, value) => {
    const cause = signal === "name" ? sesError({ name: value }) : sesError({ code: value });
    expect(classifySesError(cause).kind).toBe("retryable");
  });

  it.each(["AccountSuspendedException", "BadRequestException", "MessageRejected"])(
    "classifies plain named provider rejection %s as permanent",
    (name) => {
      expect(classifySesError(sesError({ name })).kind).toBe("permanent");
    },
  );

  it.each(["ThrottlingException", "TooManyRequestsException", "LimitExceededException"])(
    "keeps provider refusal %s retryable with incidental HTTP 503",
    (name) => {
      expect(classifySesError(sesError({ name, status: 503 })).kind).toBe("retryable");
    },
  );

  it.each([
    "InternalFailure",
    "InternalServerError",
    "ServiceUnavailable",
    "ServiceUnavailableException",
  ])("keeps internal/service name %s ambiguous with generic network code", (name) => {
    expect(classifySesError(sesError({ code: "ECONNREFUSED", name })).kind).toBe("ambiguous");
  });

  it.each([
    {
      cause: sesError({ code: "ECONNREFUSED", name: "BadRequestException" }),
      label: "BadRequestException + ECONNREFUSED",
    },
    {
      cause: sesError({ name: "MessageRejected", status: 503 }),
      label: "MessageRejected + HTTP 503",
    },
    {
      cause: sesError({ code: "EAI_AGAIN", name: "BadRequestException", status: 599 }),
      label: "BadRequestException + EAI_AGAIN + HTTP 599",
    },
  ])("keeps permanent provider rejection $label permanent", ({ cause }) => {
    expect(classifySesError(cause).kind).toBe("permanent");
  });

  it("classifies an unknown named error as ambiguous", () => {
    expect(classifySesError(sesError({ name: "SomethingUnknown" })).kind).toBe("ambiguous");
  });

  it("pins the SES client to a single attempt so lost responses cannot double-send", async () => {
    const client = makeSesClient("us-east-1");
    expect(await client.config.maxAttempts()).toBe(1);
  });

  it("allows unsubscribe headers for future marketing support", () => {
    const command = toSendEmailCommand({
      ...prepared,
      headers: {
        "List-Unsubscribe": "<https://example.com/unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    expect(command.input.Content?.Simple?.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://example.com/unsubscribe>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });

  it("rejects unsafe SES tags before sending", async () => {
    const calls: SendEmailCommand[] = [];
    const transport = makeSesEmailTransport(
      {
        send: async (command) => {
          calls.push(command);
          return { MessageId: "should-not-send", $metadata: {} };
        },
      },
      30_000,
    );

    const exit = await Effect.runPromiseExit(
      transport.send({ ...prepared, tags: { delivery_id: "not safe value" } }),
    );

    expect(String(exit)).toContain("EmailTransportError");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["subject", "managed header"],
    ["From", "managed header"],
    ["Message-ID", "managed header"],
    ["X-Bad\rName", "control character"],
    ["X-Bad\nName", "control character"],
    ["X-Bad:Name", "colon"],
    ["", "empty name"],
    ["X".repeat(127), "oversized name"],
  ])("rejects invalid SES header name %j (%s)", async (headerName) => {
    const calls: SendEmailCommand[] = [];
    const transport = makeSesEmailTransport(
      {
        send: async (command) => {
          calls.push(command);
          return { MessageId: "should-not-send", $metadata: {} };
        },
      },
      30_000,
    );

    await expect(
      Effect.runPromise(transport.send({ ...prepared, headers: { [headerName]: "valid value" } })),
    ).rejects.toMatchObject({ operation: "ses:validate-header" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["CR", "contains\rreturn"],
    ["LF", "contains\nnewline"],
    ["U+0001", "contains\u0001control"],
    ["oversized value", "x".repeat(996)],
  ])("rejects invalid SES header value (%s)", async (_label, headerValue) => {
    const calls: SendEmailCommand[] = [];
    const transport = makeSesEmailTransport(
      {
        send: async (command) => {
          calls.push(command);
          return { MessageId: "should-not-send", $metadata: {} };
        },
      },
      30_000,
    );

    await expect(
      Effect.runPromise(transport.send({ ...prepared, headers: { "X-Custom": headerValue } })),
    ).rejects.toMatchObject({ operation: "ses:validate-header" });
    expect(calls).toHaveLength(0);
  });

  it("rejects SES headers whose combined name and value are too long", async () => {
    const calls: SendEmailCommand[] = [];
    const transport = makeSesEmailTransport(
      {
        send: async (command) => {
          calls.push(command);
          return { MessageId: "should-not-send", $metadata: {} };
        },
      },
      30_000,
    );

    await expect(
      Effect.runPromise(
        transport.send({ ...prepared, headers: { ["X".repeat(126)]: "y".repeat(871) } }),
      ),
    ).rejects.toMatchObject({ operation: "ses:validate-header" });
    expect(calls).toHaveLength(0);
  });
});

function sesError(options: {
  code?: string;
  name?: string;
  status?: number;
}): Error & { $metadata?: { httpStatusCode: number }; code?: string } {
  const error = new Error(options.name ?? options.code ?? "SES error") as Error & {
    $metadata?: { httpStatusCode: number };
    code?: string;
  };
  if (options.name !== undefined) error.name = options.name;
  if (options.code !== undefined) error.code = options.code;
  if (options.status !== undefined) error.$metadata = { httpStatusCode: options.status };
  return error;
}
