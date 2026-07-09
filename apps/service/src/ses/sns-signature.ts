import { createVerify } from "node:crypto";

import { Effect } from "effect";

import { SnsVerificationError } from "./errors.ts";
import type { SnsEnvelope } from "./sns-schema.ts";

const signingCertificateTimeoutMs = 10_000;
const maxSigningCertificateBytes = 64 * 1024;

export type CertificateFetcher = (url: URL) => Effect.Effect<string, SnsVerificationError>;

type ParsedSnsTopicArn = {
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly region: string;
};

export function buildSnsStringToSign(
  envelope: SnsEnvelope,
): Effect.Effect<string, SnsVerificationError> {
  return Effect.try({
    try: () => {
      const fields = fieldsForStringToSign(envelope);
      return fields.map(([name, value]) => `${name}\n${value}\n`).join("");
    },
    catch: () => invalidSnsSignature("SNS envelope is missing required signature fields."),
  });
}

export function validateSigningCertUrl(
  signingCertUrl: string,
  topicArn: string,
): Effect.Effect<URL, SnsVerificationError> {
  return Effect.try({
    try: () => {
      const topic = parseSnsTopicArn(topicArn);
      if (!topic) throw new Error("TopicArn must be an SNS topic ARN.");

      const url = new URL(signingCertUrl);
      if (url.protocol !== "https:") throw new Error("SigningCertURL must use HTTPS.");
      if (url.username !== "" || url.password !== "") {
        throw new Error("SigningCertURL must not include credentials.");
      }
      if (url.port !== "" && url.port !== "443") {
        throw new Error("SigningCertURL must use the default HTTPS port.");
      }
      if (url.search !== "") throw new Error("SigningCertURL must not include a query string.");
      if (url.hash !== "") throw new Error("SigningCertURL must not include a fragment.");
      if (!/^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(url.pathname)) {
        throw new Error("SigningCertURL must reference an AWS SNS signing certificate.");
      }
      if (url.hostname !== snsHostForTopic(topic)) {
        throw new Error("SigningCertURL host must match the SNS topic region and partition.");
      }

      return url;
    },
    catch: () => invalidSnsSignature("Invalid SNS SigningCertURL."),
  });
}

export function fetchSigningCertificate(url: URL): Effect.Effect<string, SnsVerificationError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(signingCertificateTimeoutMs),
      });
      if (response.status !== 200) {
        throw new Error("SNS signing certificate fetch failed.");
      }

      return readLimitedResponseText(response, maxSigningCertificateBytes);
    },
    catch: () => new SnsVerificationError({ reason: "SNS signing certificate fetch failed." }),
  });
}

export function validateSnsSignatureMetadata(
  envelope: SnsEnvelope,
): Effect.Effect<void, SnsVerificationError> {
  return Effect.try({
    try: () => {
      if (envelope.SignatureVersion !== "2") {
        throw new Error("Unsupported SNS SignatureVersion.");
      }
      decodeBase64Signature(envelope.Signature);
    },
    catch: () => invalidSnsSignature("SNS signature verification failed."),
  });
}

export function verifySnsSignature(input: {
  readonly envelope: SnsEnvelope;
  readonly certificatePem: string;
  readonly stringToSign: string;
}): Effect.Effect<void, SnsVerificationError> {
  return Effect.try({
    try: () => {
      const signature = decodeBase64Signature(input.envelope.Signature);
      const verifier = createVerify("RSA-SHA256");
      verifier.update(input.stringToSign, "utf8");
      verifier.end();

      if (!verifier.verify(input.certificatePem, signature)) {
        throw new Error("SNS signature verification failed.");
      }
    },
    catch: () => invalidSnsSignature("SNS signature verification failed."),
  });
}

function fieldsForStringToSign(envelope: SnsEnvelope): ReadonlyArray<readonly [string, string]> {
  if (envelope.Type === "Notification") {
    const fields: Array<readonly [string, string]> = [
      ["Message", envelope.Message],
      ["MessageId", envelope.MessageId],
    ];

    if (envelope.Subject !== undefined) {
      fields.push(["Subject", envelope.Subject]);
    }

    fields.push(
      ["Timestamp", envelope.Timestamp],
      ["TopicArn", envelope.TopicArn],
      ["Type", envelope.Type],
    );

    return fields;
  }

  if (envelope.SubscribeURL === undefined || envelope.Token === undefined) {
    throw new Error("Confirmation messages require SubscribeURL and Token.");
  }

  return [
    ["Message", envelope.Message],
    ["MessageId", envelope.MessageId],
    ["SubscribeURL", envelope.SubscribeURL],
    ["Timestamp", envelope.Timestamp],
    ["Token", envelope.Token],
    ["TopicArn", envelope.TopicArn],
    ["Type", envelope.Type],
  ];
}

function decodeBase64Signature(signature: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 !== 0) {
    throw new Error("Signature must be base64.");
  }

  return Buffer.from(signature, "base64");
}

function invalidSnsSignature(reason: string): SnsVerificationError {
  return new SnsVerificationError({ reason });
}

function parseSnsTopicArn(topicArn: string): ParsedSnsTopicArn | null {
  const match = /^arn:(aws|aws-us-gov|aws-cn):sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_.-]{1,256}$/.exec(
    topicArn,
  );
  if (!match) return null;

  return { partition: match[1] as ParsedSnsTopicArn["partition"], region: match[2] };
}

function snsHostForTopic(topic: ParsedSnsTopicArn): string {
  const suffix = topic.partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
  return `sns.${topic.region}.${suffix}`;
}

async function readLimitedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedContentLength = Number(contentLength);
    if (!Number.isFinite(parsedContentLength) || parsedContentLength > maxBytes) {
      throw new Error("SNS signing certificate is too large.");
    }
  }

  if (!response.body) {
    throw new Error("SNS signing certificate response is empty.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- streaming reads are sequential and enforce the certificate byte cap per chunk.
    const read = await reader.read();
    if (read.done) break;

    totalBytes += read.value.byteLength;
    if (totalBytes > maxBytes) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- cancel the active reader before aborting the sequential stream read.
        await reader.cancel("SNS signing certificate is too large.");
      } catch {
        // Preserve the intended oversize error if cancellation itself fails.
      }
      throw new Error("SNS signing certificate is too large.");
    }
    chunks.push(read.value);
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    totalBytes,
  ).toString("utf8");
}
