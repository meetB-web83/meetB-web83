export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'STALE_VERSION'
  | 'UNAUTHORIZED'
  | 'INVALID_TRANSITION'
  | 'OWNER_MISMATCH'
  | 'TASK_CLAIMED'
  | 'TASK_NOT_CLAIMED'
  | 'BUILTIN_PROMPT_PROTECTED'
  | 'INTERNAL_ERROR';

export class WorkJournalError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'WorkJournalError';
  }
}

export class ValidationError extends WorkJournalError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message, 400);
  }
}

export class NotFoundError extends WorkJournalError {
  constructor(message: string) {
    super('NOT_FOUND', message, 404);
  }
}

export class IdempotencyConflictError extends WorkJournalError {
  constructor(message: string) {
    super('IDEMPOTENCY_KEY_CONFLICT', message, 409);
  }
}

export class StaleVersionError extends WorkJournalError {
  constructor(message: string) {
    super('STALE_VERSION', message, 409);
  }
}

export class UnauthorizedError extends WorkJournalError {
  constructor(message: string) {
    super('UNAUTHORIZED', message, 403);
  }
}

export class InvalidTransitionError extends WorkJournalError {
  constructor(message: string) {
    super('INVALID_TRANSITION', message, 422);
  }
}

export class OwnerMismatchError extends WorkJournalError {
  constructor(message: string) {
    super('OWNER_MISMATCH', message, 403);
  }
}

export class TaskClaimedError extends WorkJournalError {
  constructor(message: string) {
    super('TASK_CLAIMED', message, 409);
  }
}

export class TaskNotClaimedError extends WorkJournalError {
  constructor(message: string) {
    super('TASK_NOT_CLAIMED', message, 409);
  }
}

export class BuiltinPromptProtectedError extends WorkJournalError {
  constructor(message: string) {
    super('BUILTIN_PROMPT_PROTECTED', message, 400);
  }
}

export class InternalError extends WorkJournalError {
  constructor(message: string) {
    super('INTERNAL_ERROR', message, 500);
  }
}