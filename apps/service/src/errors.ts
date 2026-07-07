import { Data } from "effect";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class UnauthenticatedError extends Data.TaggedError("UnauthenticatedError")<{
  readonly message: string;
}> {}

export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly message: string;
}> {}

export class RequestValidationError extends Data.TaggedError("RequestValidationError")<{
  readonly message: string;
}> {}

export class ListNotFoundError extends Data.TaggedError("ListNotFoundError")<{
  readonly listId: string;
}> {}

export class EmptyRecipientSetError extends Data.TaggedError("EmptyRecipientSetError")<{
  readonly reason: string;
}> {}

export class RecipientLimitExceededError extends Data.TaggedError("RecipientLimitExceededError")<{
  readonly limit: number;
}> {}

export class IdempotencyConflictError extends Data.TaggedError("IdempotencyConflictError")<{
  readonly key: string;
}> {}

export class JobNotLeasedError extends Data.TaggedError("JobNotLeasedError")<{
  readonly jobId: string;
}> {}

export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly version: string;
  readonly reason: string;
}> {}

export class BootstrapError extends Data.TaggedError("BootstrapError")<{
  readonly reason: string;
}> {}
