// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Typed errors thrown by {@link CriteriaStore}.
 *
 * Each error carries an HTTP `status` so transport layers (e.g. the API routes)
 * can map a thrown store error to a response without matching on message text.
 */

export type CriteriaErrorKind =
  | "not_found"
  | "duplicate"
  | "has_dependents"
  | "validation";

/** Base class for all criteria-store errors. */
export class CriteriaStoreError extends Error {
  readonly kind: CriteriaErrorKind;
  readonly status: number;

  constructor(kind: CriteriaErrorKind, status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.status = status;
  }
}

/** A criterion referenced by id does not exist (HTTP 404). */
export class CriteriaNotFoundError extends CriteriaStoreError {
  constructor(message: string) {
    super("not_found", 404, message);
  }
}

/** A criterion with the same id already exists (HTTP 409). */
export class CriteriaDuplicateError extends CriteriaStoreError {
  constructor(message: string) {
    super("duplicate", 409, message);
  }
}

/** A criterion cannot be deleted because other criteria depend on it (HTTP 409). */
export class CriteriaHasDependentsError extends CriteriaStoreError {
  /** Ids of the active criteria that depend on the target. */
  readonly dependents: string[];

  constructor(message: string, dependents: string[]) {
    super("has_dependents", 409, message);
    this.dependents = dependents;
  }
}

/**
 * The requested change is invalid (HTTP 400): bad id format, missing dependency
 * reference, self-reference, a dependency cycle, or a gate-compatibility
 * violation.
 */
export class CriteriaValidationError extends CriteriaStoreError {
  constructor(message: string) {
    super("validation", 400, message);
  }
}
