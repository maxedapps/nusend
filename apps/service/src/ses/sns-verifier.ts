import { Context, Effect, Layer } from "effect";

import { SnsVerificationError } from "./errors.ts";
import {
  buildSnsStringToSign,
  type CertificateFetcher,
  fetchSigningCertificate,
  validateSigningCertUrl,
  validateSnsSignatureMetadata,
  verifySnsSignature,
} from "./sns-signature.ts";
import {
  decodeSnsEnvelope,
  decodeUnverifiedSnsEnvelopeString,
  type VerifiedSnsEnvelope,
} from "./sns-schema.ts";

export type SnsMessageVerifierService = {
  readonly verify: (
    message: string | unknown,
  ) => Effect.Effect<VerifiedSnsEnvelope, SnsVerificationError>;
};

export const SnsMessageVerifier = Context.Service<SnsMessageVerifierService>(
  "nusend/SnsMessageVerifier",
);

// AWS reuses one signing certificate URL for long periods and its own validators
// cache the fetched PEM. Without a cache, every inbound webhook triggers an
// outbound HTTPS fetch — turning an allowlisted (and not strongly secret) topic
// into an outbound-fetch amplifier, and coupling verification to AWS certificate
// availability during feedback bursts.
const defaultCertificateTtlMs = 60 * 60 * 1000;
const defaultCertificateCacheMaxEntries = 10;

export const SnsMessageVerifierLive: Layer.Layer<SnsMessageVerifierService> =
  Layer.succeed(SnsMessageVerifier)(makeSnsMessageVerifier());

export function makeSnsMessageVerifier(options?: {
  readonly fetchCertificate?: CertificateFetcher;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly cacheMaxEntries?: number;
}): SnsMessageVerifierService {
  const fetchCertificate = options?.fetchCertificate ?? fetchSigningCertificate;
  const now = options?.now ?? Date.now;
  const ttlMs = options?.cacheTtlMs ?? defaultCertificateTtlMs;
  const maxEntries = options?.cacheMaxEntries ?? defaultCertificateCacheMaxEntries;
  const cache = new Map<string, { pem: string; expiresAt: number }>();

  const fetchCertificateCached = (url: URL): Effect.Effect<string, SnsVerificationError> =>
    Effect.suspend(() => {
      const key = url.href;
      const entry = cache.get(key);
      if (entry && entry.expiresAt > now()) return Effect.succeed(entry.pem);

      return fetchCertificate(url).pipe(
        Effect.tap((pem) =>
          Effect.sync(() => {
            cache.set(key, { expiresAt: now() + ttlMs, pem });
            // Evict the oldest entries (Map preserves insertion order) if over cap.
            while (cache.size > maxEntries) {
              const oldest = cache.keys().next().value;
              if (oldest === undefined) break;
              cache.delete(oldest);
            }
          }),
        ),
      );
    });

  return {
    verify: (message) =>
      decodeVerifierInput(message).pipe(
        Effect.flatMap((envelope) =>
          Effect.all({
            envelope: Effect.succeed(envelope),
            signingCertUrl: validateSigningCertUrl(envelope.SigningCertURL, envelope.TopicArn),
            stringToSign: buildSnsStringToSign(envelope),
          }),
        ),
        Effect.flatMap(({ envelope, signingCertUrl, stringToSign }) =>
          validateSnsSignatureMetadata(envelope).pipe(
            Effect.flatMap(() => fetchCertificateCached(signingCertUrl)),
            Effect.flatMap((certificatePem) =>
              verifySnsSignature({ certificatePem, envelope, stringToSign }),
            ),
            Effect.as(envelope),
          ),
        ),
      ),
  };
}

export function FakeSnsMessageVerifierLive(
  behavior: (message: string | unknown) => Effect.Effect<VerifiedSnsEnvelope, SnsVerificationError>,
): Layer.Layer<SnsMessageVerifierService> {
  return Layer.succeed(SnsMessageVerifier)({ verify: behavior });
}

function decodeVerifierInput(
  input: string | unknown,
): Effect.Effect<VerifiedSnsEnvelope, SnsVerificationError> {
  const decoded =
    typeof input === "string" ? decodeUnverifiedSnsEnvelopeString(input) : decodeSnsEnvelope(input);

  return decoded.pipe(
    Effect.mapError(
      () => new SnsVerificationError({ reason: "SNS envelope has an invalid shape." }),
    ),
  );
}
