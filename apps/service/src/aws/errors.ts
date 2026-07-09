import { Data } from "effect";

export class AwsAdminError extends Data.TaggedError("AwsAdminError")<{
  readonly cause?: unknown;
  readonly kind:
    | "access_denied"
    | "missing_credentials"
    | "not_found"
    | "throttled"
    | "timeout"
    | "unknown";
  readonly operation: string;
}> {}

export function classifyAwsAdminError(operation: string, cause: unknown): AwsAdminError {
  const name = getName(cause);
  const code = getCode(cause);
  const status = getHttpStatus(cause);

  if (name === "AbortError" || name === "TimeoutError" || name === "RequestTimeout") {
    return new AwsAdminError({ cause, kind: "timeout", operation });
  }

  if (
    name === "CredentialsProviderError" ||
    name === "ProviderError" ||
    name === "UnrecognizedClientException" ||
    name === "InvalidClientTokenId" ||
    code === "CredentialsProviderError" ||
    code === "UnrecognizedClientException" ||
    code === "InvalidClientTokenId"
  ) {
    return new AwsAdminError({ cause, kind: "missing_credentials", operation });
  }

  if (name === "AccessDeniedException" || code === "AccessDenied" || status === 403) {
    return new AwsAdminError({ cause, kind: "access_denied", operation });
  }

  if (name === "NotFoundException" || name === "NotFound" || status === 404) {
    return new AwsAdminError({ cause, kind: "not_found", operation });
  }

  if (name === "ThrottlingException" || name === "TooManyRequestsException" || status === 429) {
    return new AwsAdminError({ cause, kind: "throttled", operation });
  }

  return new AwsAdminError({ cause, kind: "unknown", operation });
}

function getName(cause: unknown): string | null {
  return typeof cause === "object" && cause !== null && "name" in cause
    ? String((cause as { name: unknown }).name)
    : null;
}

function getCode(cause: unknown): string | null {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : null;
}

function getHttpStatus(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null || !("$metadata" in cause)) return null;
  const metadata = (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : null;
}
