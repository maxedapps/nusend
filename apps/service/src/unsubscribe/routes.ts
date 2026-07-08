import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { runHtmlRoute, type AppRuntime } from "../http/respond.ts";
import { escapeHtml } from "../lib/html.ts";
import {
  inspectUnsubscribeToken,
  unsubscribeByToken,
  type UnsubscribeResult,
} from "./unsubscribe.ts";

type UnsubscribeRoutesOptions = {
  readonly runtime: AppRuntime;
};

export function createUnsubscribeRoutes(options: UnsubscribeRoutesOptions): Hono {
  const routes = new Hono();

  routes.get("/:token", (context) =>
    runHtmlRoute(
      context,
      options.runtime,
      inspectUnsubscribeToken(context.req.param("token")),
      (result) => {
        if (result.kind === "Invalid")
          return htmlResponse(page("Unsubscribe link not found."), 404);
        if (result.kind === "Expired")
          return htmlResponse(page("This unsubscribe link has expired."), 410);
        if (result.delivery.mailingPurpose !== "marketing") {
          return htmlResponse(page("This message is not a marketing email."));
        }

        return htmlResponse(
          page(
            `Confirm unsubscribe for ${escapeHtml(maskEmailForDisplay(result.delivery.email))}.`,
            `<form method="post"><button name="confirm" value="unsubscribe" type="submit">Unsubscribe</button></form>`,
          ),
        );
      },
    ),
  );

  routes.post(
    "/:token",
    bodyLimit({
      maxSize: 8192,
      onError: () => htmlResponse(page("Request body is too large."), 413),
    }),
    async (context) => {
      const source = await unsubscribeSource(context.req.raw);
      if (source === null) return htmlResponse(page("Invalid unsubscribe request."), 400);

      return runHtmlRoute(
        context,
        options.runtime,
        unsubscribeByToken(context.req.param("token"), source),
        (result) => unsubscribePostResponse(result),
      );
    },
  );

  return routes;
}

async function unsubscribeSource(request: Request): Promise<"human" | "one-click" | null> {
  try {
    const form = await request.formData();
    if (form.get("List-Unsubscribe") === "One-Click") return "one-click";
    if (form.get("confirm") === "unsubscribe") return "human";
    return null;
  } catch {
    return null;
  }
}

function unsubscribePostResponse(result: UnsubscribeResult): Response {
  if (result.kind === "Invalid") return htmlResponse(page("Unsubscribe link not found."), 404);
  if (result.kind === "Expired")
    return htmlResponse(page("This unsubscribe link has expired."), 410);

  return htmlResponse(
    page(
      result.appliedMarketingUnsubscribe
        ? "You have been unsubscribed from marketing email."
        : "No marketing unsubscribe was needed for this message.",
    ),
  );
}

function maskEmailForDisplay(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "***";

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=UTF-8",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    },
    status,
  });
}

function page(message: string, extra = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribe</title></head><body><main><h1>Unsubscribe</h1><p>${message}</p>${extra}</main></body></html>`;
}
