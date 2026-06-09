/**
 * HTTP error class for the aiToolkit route handlers.
 *
 * Shaped to mirror PortOS's `ServerError` (server/lib/errorHandler.js) so a
 * thrown toolkit error normalizes into the canonical PortOS error envelope
 * `{ error, code, timestamp, context? }` when the host injects its own
 * `ServerError` + `asyncHandler`. Kept in-tree so the toolkit stays
 * self-contained (no imports out to sibling PortOS modules).
 *
 * Routes accept the error class via options (`ServerError`), defaulting to
 * this `ToolkitHttpError`. PortOS injects its real `ServerError` in
 * `server/index.js` so the host's `normalizeError` passes the instance
 * through untouched — preserving the `code`/`timestamp`/`context` clients
 * read on `/api/{providers,runs,prompts}` errors.
 *
 * Standalone (no host `asyncHandler`), `defaultAsyncHandler` below serializes
 * the same envelope, so the toolkit's error shape is consistent even outside
 * PortOS (rather than falling to Express 5's HTML error page).
 */

/**
 * Map an HTTP status to a machine-readable error code. Mirrors PortOS's
 * `getErrorCode` so standalone toolkit responses carry the same codes the
 * host would derive.
 */
export function getErrorCode(status) {
  const codeMap = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'VALIDATION_ERROR',
    500: 'INTERNAL_ERROR',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE'
  };
  return codeMap[status] || 'INTERNAL_ERROR';
}

export class ToolkitHttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ToolkitHttpError';
    this.status = options.status || 500;
    // An explicit code always wins; otherwise derive from the status so a
    // `{ status: 404 }` error reports `NOT_FOUND`, matching ServerError.
    this.code = options.code || getErrorCode(this.status);
    this.timestamp = Date.now();
    this.context = options.context || {};
  }
}

/**
 * Default async route wrapper for standalone toolkit use (no host
 * `asyncHandler` injected). Catches a thrown error and serializes it into the
 * same `{ error, code, timestamp, context? }` envelope PortOS emits.
 *
 * Without this, a thrown error would fall to Express 5's built-in handler,
 * which honors `err.status` but renders an HTML error page — dropping
 * `code`/`timestamp`/`context` for any standalone consumer. PortOS injects its
 * own `asyncHandler` (→ `errorMiddleware`), so this default never runs there.
 */
export function defaultAsyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    if (res.headersSent) return next(err);
    const status = err?.status || 500;
    res.status(status).json({
      error: err?.message || 'Internal error',
      code: err?.code || getErrorCode(status),
      timestamp: err?.timestamp || Date.now(),
      ...(err?.context && Object.keys(err.context).length > 0 && { context: err.context })
    });
  });
}
