const maxExplicitRecipients = 100;

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

type ValidationError = {
  code: "invalid_request";
  message: string;
};

export type ValidationResult<T> = { ok: true; value: T } | ({ ok: false } & ValidationError);

export function validateCreateMailingRequest(value: unknown): ValidationResult<CreateMailingInput> {
  if (!isPlainObject(value)) {
    return invalid("Request body must be a JSON object.");
  }

  const purpose = value.purpose;

  if (purpose !== "transactional" && purpose !== "marketing") {
    return invalid("purpose must be either 'transactional' or 'marketing'.");
  }

  const subject = normalizeRequiredString(value.subject, "subject");
  if (!subject.ok) return subject;

  const html = normalizeRequiredString(value.html, "html");
  if (!html.ok) return html;

  const name = normalizeOptionalString(value.name, "name");
  if (!name.ok) return name;

  const text = normalizeOptionalString(value.text, "text");
  if (!text.ok) return text;

  const scheduledAt = normalizeOptionalDate(value.scheduledAt);
  if (!scheduledAt.ok) return scheduledAt;

  const hasRecipients = Object.hasOwn(value, "recipients") && value.recipients !== undefined;
  const hasListId = Object.hasOwn(value, "listId") && value.listId !== undefined;

  if (hasRecipients === hasListId) {
    return invalid("Provide exactly one recipient source: recipients or listId.");
  }

  if (purpose === "transactional" && hasListId) {
    return invalid("Transactional mailings must use recipients and cannot use listId.");
  }

  const recipients = hasRecipients ? normalizeRecipients(value.recipients) : null;
  if (recipients && !recipients.ok) return recipients;

  const listId = hasListId ? normalizeRequiredString(value.listId, "listId") : null;
  if (listId && !listId.ok) return listId;

  return {
    ok: true,
    value: {
      html: html.value,
      listId: listId?.value ?? null,
      name: name.value,
      purpose,
      recipients: recipients?.value ?? null,
      scheduledAt: scheduledAt.value,
      subject: subject.value,
      text: text.value,
    },
  };
}

function normalizeEmail(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return invalid("Recipient email must be a string.");
  }

  const email = value.trim().toLowerCase();
  const atIndex = email.indexOf("@");

  if (
    !email ||
    atIndex <= 0 ||
    atIndex !== email.lastIndexOf("@") ||
    atIndex === email.length - 1 ||
    /\s/.test(email)
  ) {
    return invalid("Recipient email must be a valid email address.");
  }

  return { ok: true, value: email };
}

function normalizeRecipients(value: unknown): ValidationResult<CreateMailingRecipientInput[]> {
  if (!Array.isArray(value)) {
    return invalid("recipients must be an array.");
  }

  if (value.length === 0) {
    return invalid("recipients must contain at least one recipient.");
  }

  if (value.length > maxExplicitRecipients) {
    return invalid(`recipients must contain at most ${maxExplicitRecipients} recipients.`);
  }

  const seenEmails = new Set<string>();
  const recipients: CreateMailingRecipientInput[] = [];

  for (const [index, recipient] of value.entries()) {
    if (!isPlainObject(recipient)) {
      return invalid(`recipients[${index}] must be an object.`);
    }

    const email = normalizeEmail(recipient.email);
    if (!email.ok) return invalid(`recipients[${index}].email is invalid.`);

    if (seenEmails.has(email.value)) {
      return invalid(`Duplicate recipient email: ${email.value}.`);
    }

    seenEmails.add(email.value);

    const varsJson = normalizeVarsJson(recipient.vars, index);
    if (!varsJson.ok) return varsJson;

    recipients.push({ email: email.value, varsJson: varsJson.value });
  }

  return { ok: true, value: recipients };
}

function normalizeVarsJson(value: unknown, index: number): ValidationResult<string | null> {
  if (value === undefined) return { ok: true, value: null };

  if (!isPlainObject(value)) {
    return invalid(`recipients[${index}].vars must be an object.`);
  }

  try {
    return { ok: true, value: JSON.stringify(value) };
  } catch {
    return invalid(`recipients[${index}].vars must be JSON serializable.`);
  }
}

function normalizeRequiredString(value: unknown, fieldName: string): ValidationResult<string> {
  if (typeof value !== "string") {
    return invalid(`${fieldName} must be a string.`);
  }

  const normalized = value.trim();

  if (!normalized) {
    return invalid(`${fieldName} must not be empty.`);
  }

  return { ok: true, value: normalized };
}

function normalizeOptionalString(
  value: unknown,
  fieldName: string,
): ValidationResult<string | null> {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }

  if (typeof value !== "string") {
    return invalid(`${fieldName} must be a string.`);
  }

  return { ok: true, value: value.trim() || null };
}

function normalizeOptionalDate(value: unknown): ValidationResult<string | null> {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }

  if (typeof value !== "string") {
    return invalid("scheduledAt must be a string.");
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return invalid("scheduledAt must be a valid date.");
  }

  return { ok: true, value: date.toISOString() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): ValidationResult<never> {
  return { code: "invalid_request", message, ok: false };
}
