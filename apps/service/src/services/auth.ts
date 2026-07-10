// Auth service — interface + key only (driver-neutral; the Better Auth backed
// live layer is in auth-live.ts, the test fake in testing/layers.ts).
import { Context, Effect } from "effect";

import type { AuthError } from "../errors.ts";

export type SessionData = {
  session: {
    userId: string;
  };
};

export interface AuthService {
  // Raw passthrough for /api/auth/* — Better Auth owns those routes entirely.
  readonly handler: (request: Request) => Promise<Response>;
  readonly getSession: (headers: Headers) => Effect.Effect<SessionData | null, AuthError>;
}

export const Auth = Context.Service<AuthService>("nusend/Auth");
