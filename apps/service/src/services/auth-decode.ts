import { Effect, Schema } from "effect";

import { AuthError } from "../errors.ts";
import type { SessionData } from "./auth.ts";

const SessionDataSchema = Schema.NullOr(
  Schema.Struct({
    session: Schema.Struct({
      userId: Schema.String,
    }),
  }),
);

export function decodeSessionData(value: unknown): Effect.Effect<SessionData | null, AuthError> {
  return Schema.decodeUnknownEffect(SessionDataSchema)(value).pipe(
    Effect.mapError((cause) => new AuthError({ cause, operation: "decodeSession" })),
  );
}
