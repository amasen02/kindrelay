export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
export class QuotaError extends Error {
  readonly code = "QUOTA_EXCEEDED";
  constructor(message = "The workspace exceeds its storage limit.") {
    super(message);
    this.name = "QuotaError";
  }
}
export class RevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
  constructor(
    message = "This handover changed elsewhere; reload before saving.",
    expectedRevision?: number,
    actualRevision?: number,
  ) {
    super(message);
    this.name = "RevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}
export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message = "The requested handover item was not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}
export class StorageError extends Error {
  readonly code = "STORAGE_ERROR";
  constructor(message = "A storage error occurred.") {
    super(message);
    this.name = "StorageError";
  }
}

