/**
 * Base class for all SDK errors. `status` is the HTTP status the server
 * returned (or undefined for transport-level failures like DNS/TCP).
 */
export class SmartNoteError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = "SmartNoteError";
    this.status = opts.status;
    this.body = opts.body;
  }
}

/** 401 / 403 — token rejected or scope missing. */
export class SmartNoteAuthError extends SmartNoteError {
  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message, opts);
    this.name = "SmartNoteAuthError";
  }
}
