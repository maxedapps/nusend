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

export const SnsMessageVerifierLive: Layer.Layer<SnsMessageVerifierService> =
  Layer.succeed(SnsMessageVerifier)(makeSnsMessageVerifier());

export function makeSnsMessageVerifier(options?: {
  readonly fetchCertificate?: CertificateFetcher;
}): SnsMessageVerifierService {
  const fetchCertificate = options?.fetchCertificate ?? fetchSigningCertificate;

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
            Effect.flatMap(() => fetchCertificate(signingCertUrl)),
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
