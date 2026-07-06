import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../bindings.ts";
import { errorResponse } from "../lib/errors.ts";

export const apiKeyPrefix = "nusend_";

// API keys are high-entropy server-generated secrets, so a fast hash is the
// right trade-off; slow password hashing only protects low-entropy inputs.
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function findApiKeyIdByToken(db: D1Database, token: string): Promise<string | null> {
  if (!token.startsWith(apiKeyPrefix)) return null;

  const keyHash = await hashApiKey(token);
  const row = await db
    .prepare("SELECT id FROM api_keys WHERE key_hash = ?1 AND revoked_at IS NULL;")
    .bind(keyHash)
    .first<{ id: string }>();

  return row?.id ?? null;
}

export function requireApiKey(): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    // The auth scheme is case-insensitive per RFC 9110.
    const token = authorization
      ? (/^bearer\s+(\S+)$/i.exec(authorization.trim())?.[1] ?? null)
      : null;
    const apiKeyId = token ? await findApiKeyIdByToken(context.env.DB, token) : null;

    if (!apiKeyId) {
      return context.json(
        errorResponse(
          "unauthorized",
          "A valid API key is required. Send 'Authorization: Bearer nusend_...'.",
        ),
        401,
      );
    }

    context.set("apiKeyId", apiKeyId);
    await next();
  };
}
