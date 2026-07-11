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
    const error = new Error("timed out");
    error.name = "TimeoutError";
    const transport = makeSesEmailTransport(
      {
        send: async () => Promise.reject(error),
      },
      30_000,
    );

    await expect(Effect.runPromise(transport.send(prepared))).rejects.toMatchObject({
      _tag: "EmailTransportError",
      kind: "ambiguous",
      operation: "ses:send",
    });
  });

  it("classifies known SES errors conservatively", () => {
    expect(classifySesError(named("TooManyRequestsException")).kind).toBe("retryable");
    expect(classifySesError(coded("ENOTFOUND")).kind).toBe("retryable");
    expect(
      classifySesError({ $metadata: { httpStatusCode: 503 }, name: "ServiceFailure" }).kind,
    ).toBe("retryable");
    expect(classifySesError(named("BadRequestException")).kind).toBe("permanent");
    expect(classifySesError(named("MessageRejected")).kind).toBe("permanent");
    expect(classifySesError(named("AbortError")).kind).toBe("ambiguous");
    expect(classifySesError(named("SomethingUnknown")).kind).toBe("ambiguous");
    // Quota exhaustion means nothing was sent — retry, do not terminally fail.
    expect(classifySesError(named("LimitExceededException")).kind).toBe("retryable");
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

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function coded(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}
