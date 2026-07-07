// CreateMailing request boundary. Recipient-source presence rules run on the
// RAW input first (Object.hasOwn semantics — `{recipients: null, listId}` must
// be a 400, which is unobservable after normalization), then Schema decodes and
// normalizes with `errors: "all"` aggregation.
import { Result, Schema, SchemaGetter } from "effect";

import { RequestValidationError } from "../errors.ts";
import { parseLenientDateToIso } from "../lib/iso-time.ts";

const maxExplicitRecipients = 1000;

export type MailingPurpose = "marketing" | "transactional";

export type CreateMailingRecipientInput = {
  email: string;
  varsJson: string | null;
};

export type CreateMailingInput = {
  html: string;
  listId: string | null;
  name: string | null;
  purpose: MailingPurpose;
  recipients: CreateMailingRecipientInput[] | null;
  scheduledAt: string | null;
  subject: string;
  text: string | null;
};

const TrimmedNonEmpty = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value: string) => value.trim()),
    encode: SchemaGetter.passthrough(),
  }),
).check(Schema.isMinLength(1));

const TrimmedToNull = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(Schema.NullOr(Schema.String), {
    decode: SchemaGetter.transform((value: string | null) =>
      value === null ? null : value.trim() || null,
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

// Same acceptance rules as the pre-Schema validator: at least one character
// before and after a single "@", no whitespace.
const emailFilter = Schema.makeFilter<string>((email) => {
  const atIndex = email.indexOf("@");
  const valid =
    email.length > 0 &&
    atIndex > 0 &&
    atIndex === email.lastIndexOf("@") &&
    atIndex !== email.length - 1 &&
    !/\s/.test(email);

  return valid || "must be a valid email address";
});

const Email = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value: string) => value.trim().toLowerCase()),
    encode: SchemaGetter.passthrough(),
  }),
).check(emailFilter);

const VarsJson = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value: Record<string, unknown>) => JSON.stringify(value)),
    encode: SchemaGetter.forbidden(() => "encoding is not supported"),
  }),
);

const Recipient = Schema.Struct({
  email: Email,
  vars: Schema.optional(VarsJson),
});

type RecipientDecoded = typeof Recipient.Type;

const Recipients = Schema.Array(Recipient).check(
  Schema.makeFilter<readonly RecipientDecoded[]>(
    (recipients) => recipients.length >= 1 || "must contain at least one recipient",
  ),
  Schema.makeFilter<readonly RecipientDecoded[]>(
    (recipients) =>
      recipients.length <= maxExplicitRecipients ||
      `must contain at most ${maxExplicitRecipients} recipients`,
  ),
  // Duplicate detection runs on NORMALIZED emails (trim + lowercase happened in
  // the element transform).
  Schema.makeFilter<readonly RecipientDecoded[]>((recipients) => {
    const seen = new Set<string>();
    for (const recipient of recipients) {
      if (seen.has(recipient.email)) return `Duplicate recipient email: ${recipient.email}.`;
      seen.add(recipient.email);
    }
    return true;
  }),
);

// Lenient on purpose: anything `new Date` parses is accepted, then normalized
// to ISO (parseLenientDateToIso is the only allowed Date-construction site).
const LenientDateIso = Schema.String.pipe(
  Schema.decodeTo(Schema.NullOr(Schema.String), {
    decode: SchemaGetter.transform((value: string) => parseLenientDateToIso(value)),
    encode: SchemaGetter.forbidden(() => "encoding is not supported"),
  }),
).check(Schema.makeFilter<string | null>((value) => value !== null || "must be a valid date"));

const CreateMailingRequest = Schema.Struct({
  purpose: Schema.Literals(["transactional", "marketing"]),
  subject: TrimmedNonEmpty,
  html: TrimmedNonEmpty,
  name: Schema.optional(TrimmedToNull),
  text: Schema.optional(TrimmedToNull),
  scheduledAt: Schema.optional(Schema.NullOr(LenientDateIso)),
  recipients: Schema.optional(Recipients),
  listId: Schema.optional(TrimmedNonEmpty),
});

export function decodeCreateMailingRequest(
  value: unknown,
): Result.Result<CreateMailingInput, RequestValidationError> {
  if (!isPlainObject(value)) {
    return fail("Request body must be a JSON object.");
  }

  const hasRecipients = Object.hasOwn(value, "recipients") && value.recipients !== undefined;
  const hasListId = Object.hasOwn(value, "listId") && value.listId !== undefined;

  if (hasRecipients === hasListId) {
    return fail("Provide exactly one recipient source: recipients or listId.");
  }

  if (value.purpose === "transactional" && hasListId) {
    return fail("Transactional mailings must use recipients and cannot use listId.");
  }

  const decoded = Schema.decodeUnknownResult(CreateMailingRequest)(value, { errors: "all" });

  if (Result.isFailure(decoded)) {
    return fail(decoded.failure.message);
  }

  const request = decoded.success;

  return Result.succeed({
    html: request.html,
    listId: hasListId ? (request.listId ?? null) : null,
    name: request.name ?? null,
    purpose: request.purpose,
    recipients: hasRecipients
      ? [...(request.recipients ?? [])].map((recipient) => ({
          email: recipient.email,
          varsJson: recipient.vars ?? null,
        }))
      : null,
    scheduledAt: request.scheduledAt ?? null,
    subject: request.subject,
    text: request.text ?? null,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): Result.Result<never, RequestValidationError> {
  return Result.fail(new RequestValidationError({ message }));
}
