import MessageValidator from "sns-validator";
import { Context, Effect, Layer } from "effect";

import { SnsVerificationError } from "./errors.ts";
import { decodeSnsEnvelope, type VerifiedSnsEnvelope } from "./sns-schema.ts";

export type SnsMessageVerifierService = {
  readonly verify: (
    message: string | unknown,
  ) => Effect.Effect<VerifiedSnsEnvelope, SnsVerificationError>;
};

export const SnsMessageVerifier = Context.Service<SnsMessageVerifierService>(
  "nusend/SnsMessageVerifier",
);

export const SnsMessageVerifierLive: Layer.Layer<SnsMessageVerifierService> = Layer.sync(
  SnsMessageVerifier,
)(() => {
  const validator = new MessageValidator();

  return {
    verify: (message) =>
      Effect.callback<unknown, SnsVerificationError>((resume) => {
        validator.validate(message as string | Record<string, unknown>, (error, verified) => {
          if (error || !verified) {
            resume(
              Effect.fail(
                new SnsVerificationError({ reason: error?.message ?? "SNS verification failed." }),
              ),
            );
            return;
          }

          resume(Effect.succeed(verified));
        });
      }).pipe(
        Effect.flatMap((verified) =>
          decodeSnsEnvelope(verified).pipe(
            Effect.mapError((error) => new SnsVerificationError({ reason: error.reason })),
          ),
        ),
      ),
  };
});

export function FakeSnsMessageVerifierLive(
  behavior: (message: string | unknown) => Effect.Effect<VerifiedSnsEnvelope, SnsVerificationError>,
): Layer.Layer<SnsMessageVerifierService> {
  return Layer.succeed(SnsMessageVerifier)({ verify: behavior });
}
