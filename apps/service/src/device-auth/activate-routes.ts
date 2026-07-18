import { randomBytes, timingSafeEqual } from "node:crypto";
import { Cause, Effect, Exit } from "effect";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { logCause, safeRequestMeta, type AppRuntime, type AppServices } from "../http/respond.ts";
import { escapeHtml } from "../lib/html.ts";
import { Auth } from "../services/auth.ts";
import { makeAttemptLimiter, type AttemptLimiter } from "./attempt-limiter.ts";
import { DeviceAuthorizations, type DeviceAuthorizationActivation } from "./service.ts";
import { normalizeUserCode } from "./token.ts";

type ActivationRoutesOptions = {
  readonly attemptLimiter?: AttemptLimiter;
  readonly runtime: AppRuntime;
  // Canonical public origin (from BETTER_AUTH_URL). Behind a TLS-terminating
  // proxy the raw request URL is http://internal, so the same-origin check must
  // compare against this instead. Falls back to the request origin when unset.
  readonly publicOrigin?: string;
};

type ActivationResult = {
  readonly body: string;
  readonly status: ContentfulStatusCode;
};

const lockedMessage = "Too many attempts. Try again later.";

export function createActivationRoutes(options: ActivationRoutesOptions): Hono {
  const routes = new Hono();
  const attemptLimiter =
    options.attemptLimiter ?? makeAttemptLimiter({ max: 10, windowMs: 15 * 60_000 });

  routes.get("/activate", async (context) => {
    const code = context.req.query("code") ?? "";
    const result = await runActivation(
      options.runtime,
      context.req.raw,
      Effect.gen(function* () {
        const auth = yield* Auth;
        const session = yield* auth.getSession(context.req.raw.headers);
        if (!session) return activationResult(renderSignIn(code));

        const userId = session.session.userId;
        if (attemptLimiter.isLocked(userId)) {
          return activationResult(renderMessage(lockedMessage), 403);
        }

        const activation = code ? yield* (yield* DeviceAuthorizations).inspect(code) : null;
        if (code && !activation) attemptLimiter.recordFailure(userId);
        return activationResult(
          renderActivationForm({
            activation,
            code,
            effectiveOrigin: effectiveOrigin(context.req.raw, options.publicOrigin),
          }),
        );
      }),
    );

    return html(context, context.req.raw, result.body, result.status);
  });

  routes.post("/activate", async (context) => {
    if (!isSameOriginPost(context.req.raw, options.publicOrigin)) {
      return html(context, context.req.raw, renderMessage("Invalid activation request."), 403);
    }

    // formData() throws on a non-form body (e.g. a JSON content-type); handle it
    // as a bad request rather than letting it become an unhandled 500.
    let code: string;
    let csrf: string;
    let action: string;
    try {
      const form = await context.req.raw.formData();
      code = String(form.get("code") ?? "");
      csrf = String(form.get("csrf") ?? "");
      action = String(form.get("action") ?? "");
    } catch {
      return html(context, context.req.raw, renderMessage("Invalid activation request."), 400);
    }
    if (!validCsrf(csrf, context.req.header("cookie") ?? "")) {
      return html(context, context.req.raw, renderMessage("Invalid activation token."), 403);
    }

    const result = await runActivation(
      options.runtime,
      context.req.raw,
      Effect.gen(function* () {
        const auth = yield* Auth;
        const session = yield* auth.getSession(context.req.raw.headers);
        if (!session) return activationResult(renderSignIn(code));

        const userId = session.session.userId;
        if (attemptLimiter.isLocked(userId)) {
          return activationResult(renderMessage(lockedMessage), 403);
        }

        const deviceAuthorizations = yield* DeviceAuthorizations;
        if (action === "approve") {
          const approved = yield* deviceAuthorizations.approve({ userCode: code, userId }).pipe(
            Effect.as(true),
            Effect.catchTag("RequestValidationError", () =>
              Effect.sync(() => {
                attemptLimiter.recordFailure(userId);
                return false;
              }),
            ),
          );
          return activationResult(
            approved
              ? renderMessage("CLI device approved. You can return to the terminal.")
              : renderMessage("Activation failed."),
          );
        }
        if (action === "deny") {
          const denied = yield* deviceAuthorizations.deny({ userCode: code }).pipe(
            Effect.as(true),
            Effect.catchTag("RequestValidationError", () =>
              Effect.sync(() => {
                attemptLimiter.recordFailure(userId);
                return false;
              }),
            ),
          );
          return activationResult(
            denied ? renderMessage("CLI device denied.") : renderMessage("Activation failed."),
          );
        }
        return activationResult(renderMessage("Unknown activation action."), 400);
      }),
    );

    return html(context, context.req.raw, result.body, result.status);
  });

  return routes;
}

async function runActivation(
  runtime: AppRuntime,
  request: Request,
  program: Effect.Effect<ActivationResult, unknown, AppServices>,
): Promise<ActivationResult> {
  const exit = await runtime.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;
  await runtime.runPromise(logCause(exit.cause as Cause.Cause<unknown>, safeRequestMeta(request)));
  return activationResult(renderMessage("Activation failed."), 500);
}

function activationResult(body: string, status: ContentfulStatusCode = 200): ActivationResult {
  return { body, status };
}

function html(
  context: {
    header: (name: string, value: string) => void;
    html: (body: string, status?: ContentfulStatusCode) => Response | Promise<Response>;
  },
  request: Request,
  body: string,
  status: ContentfulStatusCode = 200,
): Response | Promise<Response> {
  const csrf = randomBytes(24).toString("base64url");
  const secure =
    request.headers.get("x-forwarded-proto") === "https" ||
    new URL(request.url).protocol === "https:";
  context.header("cache-control", "no-store");
  context.header("pragma", "no-cache");
  context.header("x-robots-tag", "noindex, nofollow");
  // Defense-in-depth against clickjacking of the Approve button and inline script.
  context.header("x-frame-options", "DENY");
  context.header(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
  );
  context.header(
    "set-cookie",
    `nusend_cli_activation_csrf=${csrf}; HttpOnly; SameSite=Lax; Path=/cli/activate${secure ? "; Secure" : ""}`,
  );
  return context.html(body.replaceAll("__CSRF__", csrf), status);
}

function renderSignIn(code: string): string {
  const normalizedCode = normalizeUserCode(code);
  const validCode = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalizedCode) ? normalizedCode : null;
  const callback = `/cli/activate${validCode ? `?code=${encodeURIComponent(validCode)}` : ""}`;
  const embeddedCallback = JSON.stringify(callback).replaceAll("<", "\\u003c");

  return page(
    "Sign in required",
    `<p>Sign in with Google to approve this Nusend CLI device.</p>
<button id="signin" type="button">Sign in with Google</button>
<p id="signin-error" hidden>Sign-in failed. Reload and try again.</p>
<noscript><p>JavaScript is required to sign in.</p></noscript>
<script>
  document.getElementById("signin").addEventListener("click", async () => {
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: ${embeddedCallback} }),
      });
      const data = await response.json();
      if (response.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      throw new Error("bad response");
    } catch {
      document.getElementById("signin-error").hidden = false;
    }
  });
</script>`,
  );
}

function renderActivationForm(input: {
  readonly activation: DeviceAuthorizationActivation | null;
  readonly code: string;
  readonly effectiveOrigin: string;
}): string {
  if (!input.code) {
    return page(
      "Activate Nusend CLI",
      `<form method="get" action="/cli/activate"><label>User code <input name="code" autocomplete="one-time-code" /></label><button type="submit">Continue</button></form>`,
    );
  }
  if (!input.activation) return renderMessage("Device authorization code is invalid or expired.");

  const permissions = Object.entries(input.activation.permissions)
    .flatMap(([resource, actions]) => (actions ?? []).map((action) => `${resource}:${action}`))
    .map((permission) => `<li>${escapeHtml(permission)}</li>`)
    .join("");

  return page(
    "Approve Nusend CLI",
    `<p>Instance: <strong>${escapeHtml(input.effectiveOrigin)}</strong></p>
<p>Client: <strong>${escapeHtml(input.activation.clientName)}</strong></p>
<p>User code: <code>${escapeHtml(input.activation.userCodePreview)}</code></p>
<p>Expires: ${escapeHtml(input.activation.expiresAt)}</p>
<p>Only approve this code if you requested it from your CLI.</p>
<ul>${permissions}</ul>
<form method="post" action="/cli/activate">
  <input type="hidden" name="csrf" value="__CSRF__" />
  <input type="hidden" name="code" value="${escapeHtml(input.activation.userCode)}" />
  <button name="action" value="approve" type="submit">Approve</button>
  <button name="action" value="deny" type="submit">Deny</button>
</form>`,
  );
}

function renderMessage(message: string): string {
  return page("Nusend CLI activation", `<p>${escapeHtml(message)}</p>`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;line-height:1.5;max-width:42rem;margin:4rem auto;padding:0 1rem}button,input{font:inherit;padding:.5rem;margin:.25rem}code{background:#eee;padding:.1rem .25rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function validCsrf(value: string, cookie: string): boolean {
  const expected = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("nusend_cli_activation_csrf="))
    ?.slice("nusend_cli_activation_csrf=".length);
  if (!expected || !value) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function effectiveOrigin(request: Request, publicOrigin?: string): string {
  return new URL(publicOrigin ?? request.url).origin;
}

function isSameOriginPost(request: Request, publicOrigin?: string): boolean {
  const expected = effectiveOrigin(request, publicOrigin);
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (!origin && !referer) return false;
  if (origin && origin !== expected) return false;
  if (!referer) return true;

  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}
