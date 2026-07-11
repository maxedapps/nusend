import { createSign, generateKeyPairSync } from "node:crypto";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSnsStringToSign,
  fetchSigningCertificate,
  validateSigningCertUrl,
} from "./sns-signature.ts";
import { makeSnsMessageVerifier } from "./sns-verifier.ts";
import type { SnsEnvelope } from "./sns-schema.ts";

const topicArn = "arn:aws:sns:us-east-1:123456789012:nusend-test";
const signingCertUrl = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem";

const baseEnvelope: SnsEnvelope = {
  Message: '{"notificationType":"Bounce"}',
  MessageId: "message-1",
  Signature: "placeholder-signature==",
  SignatureVersion: "2",
  SigningCertURL: signingCertUrl,
  Timestamp: "2026-07-09T12:00:00.000Z",
  TopicArn: topicArn,
  Type: "Notification",
};

describe("SnsMessageVerifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the canonical string for notifications with and without Subject", async () => {
    const expectedWithoutSubject = awsValidatorStyleStringToSign([
      ["Message", baseEnvelope.Message],
      ["MessageId", baseEnvelope.MessageId],
      ["Timestamp", baseEnvelope.Timestamp],
      ["TopicArn", baseEnvelope.TopicArn],
      ["Type", "Notification"],
    ]);
    const expectedWithSubject = awsValidatorStyleStringToSign([
      ["Message", baseEnvelope.Message],
      ["MessageId", baseEnvelope.MessageId],
      ["Subject", "Delivery status"],
      ["Timestamp", baseEnvelope.Timestamp],
      ["TopicArn", baseEnvelope.TopicArn],
      ["Type", "Notification"],
    ]);

    await expect(Effect.runPromise(buildSnsStringToSign(baseEnvelope))).resolves.toBe(
      expectedWithoutSubject,
    );
    expect(expectedWithoutSubject.endsWith("Notification\n")).toBe(true);

    await expect(
      Effect.runPromise(buildSnsStringToSign({ ...baseEnvelope, Subject: "Delivery status" })),
    ).resolves.toBe(expectedWithSubject);
    expect(expectedWithSubject.endsWith("Notification\n")).toBe(true);
  });

  it("builds the canonical string for subscription confirmations", async () => {
    const subscribeUrl = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription";
    const token = "token-1";
    const envelope: SnsEnvelope = {
      ...baseEnvelope,
      Message: "You have chosen to subscribe.",
      SubscribeURL: subscribeUrl,
      Token: token,
      Type: "SubscriptionConfirmation",
    };

    const expected = awsValidatorStyleStringToSign([
      ["Message", envelope.Message],
      ["MessageId", envelope.MessageId],
      ["SubscribeURL", subscribeUrl],
      ["Timestamp", envelope.Timestamp],
      ["Token", token],
      ["TopicArn", envelope.TopicArn],
      ["Type", "SubscriptionConfirmation"],
    ]);

    await expect(Effect.runPromise(buildSnsStringToSign(envelope))).resolves.toBe(expected);
    expect(expected.endsWith("SubscriptionConfirmation\n")).toBe(true);
  });

  it("rejects confirmation messages without required canonical fields", async () => {
    await expect(
      Effect.runPromise(
        buildSnsStringToSign({
          ...baseEnvelope,
          SubscribeURL: undefined,
          Type: "SubscriptionConfirmation",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SnsVerificationError" });

    await expect(
      Effect.runPromise(
        buildSnsStringToSign({
          ...baseEnvelope,
          Token: undefined,
          Type: "UnsubscribeConfirmation",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SnsVerificationError" });
  });

  it.each([
    [
      "arn:aws:sns:us-east-1:123456789012:topic",
      "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    ],
    [
      "arn:aws-us-gov:sns:us-gov-west-1:123456789012:topic",
      "https://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    ],
    [
      "arn:aws-cn:sns:cn-north-1:123456789012:topic",
      "https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-abc123.pem",
    ],
  ])("accepts SNS signing certificate for topic %s at URL %s", async (arn, url) => {
    await expect(Effect.runPromise(validateSigningCertUrl(url, arn))).resolves.toEqual(
      new URL(url),
    );
  });

  it.each([
    ["http://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem", topicArn],
    ["https://example.com/SimpleNotificationService-abc123.pem", topicArn],
    ["https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem", topicArn],
    ["https://user@sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem", topicArn],
    ["https://sns.us-east-1.amazonaws.com:8443/SimpleNotificationService-abc123.pem", topicArn],
    ["https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.txt", topicArn],
    ["https://sns.us-east-1.amazonaws.com/cert.pem", topicArn],
    ["https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem?x=1", topicArn],
    ["https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem#frag", topicArn],
    [signingCertUrl, "not-an-arn"],
  ])("rejects unsafe SNS signing certificate URL %s for topic %s", async (url, arn) => {
    await expect(Effect.runPromise(validateSigningCertUrl(url, arn))).rejects.toMatchObject({
      _tag: "SnsVerificationError",
    });
  });

  it("verifies a valid SignatureVersion 2 notification", async () => {
    const { envelope, publicKeyPem } = await signedEnvelope(
      baseEnvelope,
      notificationStringToSignFields(baseEnvelope),
    );
    const verifier = makeSnsMessageVerifier({
      fetchCertificate: () => Effect.succeed(publicKeyPem),
    });

    await expect(
      Effect.runPromise(verifier.verify(JSON.stringify(envelope))),
    ).resolves.toMatchObject({
      MessageId: envelope.MessageId,
      SignatureVersion: "2",
      TopicArn: topicArn,
      Type: "Notification",
    });
  });

  it("verifies a valid SignatureVersion 2 notification with Subject", async () => {
    const subjectEnvelope = { ...baseEnvelope, MessageId: "message-subject", Subject: "Status" };
    const { envelope, publicKeyPem } = await signedEnvelope(
      subjectEnvelope,
      notificationStringToSignFields(subjectEnvelope),
    );
    const verifier = makeSnsMessageVerifier({
      fetchCertificate: () => Effect.succeed(publicKeyPem),
    });

    await expect(
      Effect.runPromise(verifier.verify(JSON.stringify(envelope))),
    ).resolves.toMatchObject({
      MessageId: envelope.MessageId,
      Subject: "Status",
      SignatureVersion: "2",
      Type: "Notification",
    });
  });

  it("rejects tampered messages", async () => {
    const { envelope, publicKeyPem } = await signedEnvelope(
      baseEnvelope,
      notificationStringToSignFields(baseEnvelope),
    );
    const verifier = makeSnsMessageVerifier({
      fetchCertificate: () => Effect.succeed(publicKeyPem),
    });

    await expect(
      Effect.runPromise(verifier.verify(JSON.stringify({ ...envelope, Message: "tampered" }))),
    ).rejects.toMatchObject({ _tag: "SnsVerificationError" });
  });

  it("caches the signing certificate per URL and refetches after the TTL", async () => {
    const { envelope, publicKeyPem } = await signedEnvelope(
      baseEnvelope,
      notificationStringToSignFields(baseEnvelope),
    );
    const fetchCertificate = vi.fn(() => Effect.succeed(publicKeyPem));
    let clock = 1_000;
    const verifier = makeSnsMessageVerifier({
      cacheTtlMs: 1_000,
      fetchCertificate,
      now: () => clock,
    });

    await Effect.runPromise(verifier.verify(JSON.stringify(envelope)));
    await Effect.runPromise(verifier.verify(JSON.stringify(envelope)));
    // Second verification within the TTL reuses the cached certificate.
    expect(fetchCertificate).toHaveBeenCalledTimes(1);

    // After the TTL elapses, it refetches.
    clock += 2_000;
    await Effect.runPromise(verifier.verify(JSON.stringify(envelope)));
    expect(fetchCertificate).toHaveBeenCalledTimes(2);
  });

  it.each(["1", "3"])("rejects unsupported SignatureVersion %s", async (version) => {
    const unsignedEnvelope = {
      ...baseEnvelope,
      SignatureVersion: version,
    };
    const { envelope, publicKeyPem } = await signedEnvelope(
      unsignedEnvelope,
      notificationStringToSignFields(unsignedEnvelope),
    );
    const fetchCertificate = vi.fn(() => Effect.succeed(publicKeyPem));
    const verifier = makeSnsMessageVerifier({ fetchCertificate });

    await expect(
      Effect.runPromise(verifier.verify(JSON.stringify(envelope))),
    ).rejects.toMatchObject({
      _tag: "SnsVerificationError",
    });
    expect(fetchCertificate).not.toHaveBeenCalled();
  });

  it("rejects invalid base64 signatures", async () => {
    const fetchCertificate = vi.fn(() => Effect.succeed("unused"));
    const verifier = makeSnsMessageVerifier({ fetchCertificate });

    await expect(
      Effect.runPromise(
        verifier.verify(JSON.stringify({ ...baseEnvelope, Signature: "not-base64!" })),
      ),
    ).rejects.toMatchObject({ _tag: "SnsVerificationError" });
    expect(fetchCertificate).not.toHaveBeenCalled();
  });

  it("maps certificate fetch rejection to SnsVerificationError", async () => {
    const fetchCalls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: URL | string, init?: RequestInit) => {
      if (init) fetchCalls.push(init);
      return new Response("nope", { status: 500 });
    });

    await expectCertificateFetchFailure();
    expect(fetchCalls[0]?.redirect).toBe("error");
  });

  it("maps a 204 certificate response to SnsVerificationError", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));

    await expectCertificateFetchFailure();
  });

  it("rejects an oversized certificate content-length", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("small", {
          headers: { "content-length": String(64 * 1024 + 1) },
        }),
    );

    await expectCertificateFetchFailure();
  });

  it("cancels a certificate stream that exceeds the body cap", async () => {
    let streamCancelled = false;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              streamCancelled = true;
            },
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024 + 1));
            },
          }),
        ),
    );

    await expectCertificateFetchFailure();
    expect(streamCancelled).toBe(true);
  });

  it("rejects malformed required SNS fields", async () => {
    const verifier = makeSnsMessageVerifier({ fetchCertificate: () => Effect.succeed("unused") });

    await expect(
      Effect.runPromise(
        verifier.verify(JSON.stringify({ Type: "Notification", SignatureVersion: "2" })),
      ),
    ).rejects.toMatchObject({ _tag: "SnsVerificationError" });
  });
});

async function expectCertificateFetchFailure(): Promise<void> {
  await expect(
    Effect.runPromise(fetchSigningCertificate(new URL(signingCertUrl))),
  ).rejects.toMatchObject({ _tag: "SnsVerificationError" });
}

async function signedEnvelope(
  envelope: SnsEnvelope,
  fields: readonly (readonly [string, string])[],
): Promise<{
  readonly envelope: SnsEnvelope;
  readonly publicKeyPem: string;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stringToSign = awsValidatorStyleStringToSign(fields);
  const signer = createSign("RSA-SHA256");
  signer.update(stringToSign, "utf8");
  signer.end();

  return {
    envelope: { ...envelope, Signature: signer.sign(privateKey, "base64") },
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function notificationStringToSignFields(
  envelope: SnsEnvelope,
): readonly (readonly [string, string])[] {
  return envelope.Subject === undefined
    ? [
        ["Message", envelope.Message],
        ["MessageId", envelope.MessageId],
        ["Timestamp", envelope.Timestamp],
        ["TopicArn", envelope.TopicArn],
        ["Type", "Notification"],
      ]
    : [
        ["Message", envelope.Message],
        ["MessageId", envelope.MessageId],
        ["Subject", envelope.Subject],
        ["Timestamp", envelope.Timestamp],
        ["TopicArn", envelope.TopicArn],
        ["Type", "Notification"],
      ];
}

// AWS's JS/PHP SNS validators append a newline after every signed value,
// including the final Type value, despite ambiguous AWS docs prose.
function awsValidatorStyleStringToSign(fields: readonly (readonly [string, string])[]): string {
  return fields.map(([name, value]) => `${name}\n${value}\n`).join("");
}
