import { Effect } from "effect";

import { escapeHtml } from "../lib/html.ts";
import type { DeliveryContext, RenderedEmail } from "./schema.ts";
import { SendPreparationError } from "./schema.ts";

const placeholderPattern = /{{\s*([^{}]+?)\s*}}/g;

export type RenderDeliveryEmailOptions = {
  readonly unsubscribeUrl?: string;
};

export function renderDeliveryEmail(
  context: DeliveryContext,
  options: RenderDeliveryEmailOptions = {},
): Effect.Effect<RenderedEmail, SendPreparationError> {
  return Effect.gen(function* () {
    const vars = yield* parseVars(context.delivery.varsJson);
    const unsubscribeUrl = options.unsubscribeUrl ?? null;
    const model = {
      unsubscribe: { url: unsubscribeUrl },
      user: { email: context.delivery.email },
      vars,
    };

    return {
      html: yield* renderTemplate(context.mailing.html, model, "html"),
      subject: yield* renderTemplate(context.mailing.subject, model, "text"),
      text: context.mailing.text
        ? yield* renderTemplate(context.mailing.text, model, "text")
        : null,
      unsubscribeUrl,
    };
  });
}

export function containsUnsubscribeUrlPlaceholder(template: string): boolean {
  return /{{\s*unsubscribe\.url\s*}}/.test(template);
}

function parseVars(
  varsJson: string | null,
): Effect.Effect<Record<string, unknown>, SendPreparationError> {
  if (varsJson === null) return Effect.succeed({});

  return Effect.try({
    try: () => {
      const parsed = JSON.parse(varsJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("vars must be a JSON object");
      }
      return parsed as Record<string, unknown>;
    },
    catch: () => new SendPreparationError({ message: "Recipient vars_json is invalid." }),
  });
}

type RenderModel = {
  readonly unsubscribe: { readonly url: string | null };
  readonly user: { readonly email: string };
  readonly vars: Record<string, unknown>;
};

function renderTemplate(
  template: string,
  model: RenderModel,
  mode: "html" | "text",
): Effect.Effect<string, SendPreparationError> {
  return Effect.gen(function* () {
    let output = "";
    let lastIndex = 0;

    for (const match of template.matchAll(placeholderPattern)) {
      output += template.slice(lastIndex, match.index);
      const value = yield* resolvePlaceholder(match[1].trim(), model);
      output += mode === "html" ? escapeHtml(value) : value;
      lastIndex = match.index + match[0].length;
    }

    output += template.slice(lastIndex);
    return output;
  });
}

function resolvePlaceholder(
  path: string,
  model: RenderModel,
): Effect.Effect<string, SendPreparationError> {
  if (path === "user.email") return Effect.succeed(model.user.email);
  if (path === "unsubscribe.url") {
    if (model.unsubscribe.url === null) {
      return Effect.fail(
        new SendPreparationError({ message: "Unsupported placeholder: unsubscribe.url." }),
      );
    }
    return Effect.succeed(model.unsubscribe.url);
  }

  if (!path.startsWith("vars.")) {
    return Effect.fail(new SendPreparationError({ message: `Unsupported placeholder: ${path}.` }));
  }

  const key = path.slice("vars.".length);
  if (!Object.hasOwn(model.vars, key)) {
    return Effect.fail(
      new SendPreparationError({ message: `Missing placeholder value: ${path}.` }),
    );
  }

  const value = model.vars[key];
  if (typeof value === "string") return Effect.succeed(value);
  if (typeof value === "number" || typeof value === "boolean") return Effect.succeed(String(value));

  return Effect.fail(new SendPreparationError({ message: `Placeholder is not scalar: ${path}.` }));
}
