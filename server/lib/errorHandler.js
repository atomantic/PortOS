/**
 * Error handling utilities for graceful server error management
 * Catches errors in async routes and emits Socket.IO events for UI alerting
 */

import { EventEmitter } from 'events';

// Global error event emitter for broadcasting errors
export const errorEvents = new EventEmitter();

// Fields commonly attached to Node system errors (e.g. ECONNREFUSED, ENOTFOUND)
// — preserved when unwrapping err.cause for diagnostic logging.
const SYSTEM_ERROR_KEYS = ['code', 'errno', 'syscall', 'hostname', 'address', 'port'];

const causeSuffix = (error) =>
  error.context?.causeChain ? ` ← ${error.context.causeChain}` : '';

/**
 * Strip the `?query` and `#fragment` (whichever appears first, plus everything
 * after) from a URL or request path so tokens like `?access_token=…` or
 * `#access_token=…` from an OAuth implicit-grant callback don't leak into
 * server logs or stored error reports. Returns the input unchanged when
 * neither separator is present. Server-side `req.url` never carries a
 * fragment (browsers don't send them), so the fragment strip is a no-op
 * for the `routePath` caller — it's there for the client-error sanitizer.
 */
export function stripQueryString(url) {
  if (typeof url !== 'string') return url;
  const qIndex = url.indexOf('?');
  const hIndex = url.indexOf('#');
  const cut = (qIndex === -1)
    ? hIndex
    : (hIndex === -1 ? qIndex : Math.min(qIndex, hIndex));
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Build the path portion of a request URL for logging. Falls back through
 * `originalUrl` → `url` → '/' and runs `stripQueryString` to keep tokens out
 * of server logs.
 */
const routePath = (req) => stripQueryString(req.originalUrl || req.url || '/');

/**
 * Enhanced error object with metadata
 */
export class ServerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ServerError';
    this.status = options.status || 500;
    // Derive the machine-readable code from the HTTP status when the caller
    // didn't pass one explicitly — so `new ServerError(msg, { status: 404 })`
    // emits `NOT_FOUND`, not `INTERNAL_ERROR`. An explicit `code` always wins.
    this.code = options.code || getErrorCode(this.status);
    this.timestamp = Date.now();
    this.context = options.context || {};
    this.severity = options.severity || 'error'; // error, critical, warning
    this.canAutoFix = options.canAutoFix || false;
  }
}

/**
 * Wrap async route handlers to catch errors and emit Socket.IO events
 * Also sends error response to client
 */
/**
 * Translate a Zod safeParse() failure into the standard `Validation failed:`
 * ServerError shape that the rest of PortOS speaks. Pass the result of
 * `schema.safeParse(...)` after confirming `.success === false`.
 */
export function failValidation(parsed) {
  throw new ServerError(
    `Validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
    { status: 400, code: 'VALIDATION_ERROR' },
  );
}

/**
 * Build a service-error → ServerError mapper for route handlers.
 *
 * Domain services throw coded plain Errors (`Object.assign(new Error(msg),
 * { code })`); routes catch them and rethrow as `ServerError`s so the
 * centralized middleware renders the standard `{ error, code, timestamp,
 * context? }` envelope. This factory replaces the ~identical `mapServiceError`
 * copies that had accreted across the pipeline / builder / media routers.
 *
 * @param {Record<string, number>} statusMap  service error `code` → HTTP status.
 * @param {(err: any) => object|undefined} [buildContext]  optional per-error
 *   context builder (e.g. a merge-cascade or delete-guard diagnostic payload);
 *   an empty/undefined result is omitted from the response envelope.
 * @returns {(err: any) => any} mapper — recognized codes become a `ServerError`;
 *   anything else passes through untouched (it normalizes to a 500).
 */
export function createServiceErrorMapper(statusMap, buildContext) {
  return (err) => {
    const status = statusMap[err?.code];
    if (!status) return err;
    const context = buildContext ? buildContext(err) : undefined;
    return new ServerError(err.message, {
      status,
      code: err.code,
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
    });
  };
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      const io = req.app.get('io');
      const error = normalizeError(err);

      // Log the error (skip stack traces for upstream platform issues)
      const route = `${req.method} ${routePath(req)}`;
      const suffix = causeSuffix(error);
      const logMsg = `❌ Route error [${route}]: ${error.message}${suffix}`;
      if (error.code === 'PLATFORM_UNAVAILABLE') {
        console.warn(`⚠️ Platform unavailable [${route}]: ${error.message}${suffix}`);
      } else if (error.severity === 'warning') {
        // Expected high-volume 404s (e.g. speculative media-job archive
        // lookups) — already classified as benign; don't pollute server logs.
      } else if (error.status >= 500) {
        console.error(logMsg, error.stack ? error.stack : '');
      } else {
        const details = error.context?.details;
        console.error(details ? `${logMsg}: ${JSON.stringify(details)}` : logMsg);
      }

      return sendErrorResponse(res, error, { io });
    });
  };
}

/**
 * Build the standard PortOS error body: `{ error, code, timestamp }` plus a
 * `context` when the sanitized context has anything left in it. Every error
 * response the API emits goes through here so no route can invent its own
 * envelope shape.
 */
export function buildErrorEnvelope(error, safeContext) {
  return {
    error: error.message,
    code: error.code,
    timestamp: error.timestamp,
    ...(safeContext && Object.keys(safeContext).length > 0 && { context: safeContext })
  };
}

/**
 * Send an error as the standard envelope, sanitizing context once and (when an
 * `io` is supplied) emitting the matching socket event so the two channels
 * can't drift on what's stripped.
 *
 * Use this from anywhere that must answer a request OUTSIDE `asyncHandler`'s
 * catch — `res.sendFile` callbacks, middleware that short-circuits, PTY/timer
 * callbacks — where `throw` has nothing to bubble to. It never throws and
 * no-ops the write once headers are sent.
 *
 * @returns {ServerError} the normalized error, for callers that want to log it.
 */
export function sendErrorResponse(res, err, { io } = {}) {
  const error = normalizeError(err);
  const safeContext = sanitizeContext(error.context);
  if (io) {
    emitErrorEvent(io, error, safeContext);
  }
  if (!res.headersSent) {
    res.status(error.status).json(buildErrorEnvelope(error, safeContext));
  }
  return error;
}

/**
 * Walk an Error's `cause` chain (Node's native fetch wraps the actual reason
 * in `err.cause` — without unwrapping, server logs show only "fetch failed").
 * Returns context fields ready to merge: { causeChain: "Foo: msg → Bar: msg",
 * cause: [{ name, message, ...SYSTEM_ERROR_KEYS }] }, or an empty object when
 * there is no cause — callers can spread the result unconditionally.
 */
function describeCauseChain(err) {
  const cause = [];
  const labels = [];
  let current = err?.cause;
  const seen = new Set();
  while (current && !seen.has(current) && cause.length < 5) {
    seen.add(current);
    const name = current?.constructor?.name || current?.name || 'Unknown';
    const message = current?.message ?? String(current);
    labels.push(`${name}: ${message}`);
    const entry = { name, message };
    for (const key of SYSTEM_ERROR_KEYS) {
      if (current[key] !== undefined) entry[key] = current[key];
    }
    cause.push(entry);
    current = current.cause;
  }
  return cause.length ? { causeChain: labels.join(' → '), cause } : {};
}

/**
 * Normalize different error types to ServerError
 */
export function normalizeError(err) {
  if (err instanceof ServerError) {
    return err;
  }

  if (err instanceof Error) {
    const status = err.status || 500;
    const code = err.code || getErrorCode(status);
    const context = { originalError: err.constructor.name, ...describeCauseChain(err) };
    return new ServerError(err.message, { status, code, context });
  }

  // Handle string or other error types
  return new ServerError(String(err), {
    status: 500,
    code: 'INTERNAL_ERROR'
  });
}

/**
 * Get appropriate error code from HTTP status
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

/**
 * Strip sensitive fields from error context before broadcasting to clients.
 * Full context is still available in server-side console logs. Exported so
 * socket-side listeners can defensively sanitize when they receive an error
 * that was emitted directly (bypassing `emitErrorEvent`).
 */
export function sanitizeContext(context) {
  if (!context || typeof context !== 'object') return context;
  const sensitive = ['apikey', 'token', 'secret', 'password', 'credential', 'authorization', 'bearer', 'envvars', 'secretenvvars'];
  const visited = new WeakSet();

  function sanitize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (visited.has(value)) return undefined;
    visited.add(value);
    if (Array.isArray(value)) return value.map(sanitize).filter(v => v !== undefined);
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      if (sensitive.some(s => key.toLowerCase().includes(s))) continue;
      const sanitized = sanitize(val);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }

  return sanitize(context);
}

/**
 * Emit error event via Socket.IO to alert UI.
 * `precomputedSafeContext` lets callers sanitize once and share with the HTTP
 * response so the two channels can't drift on what's stripped.
 *
 * `errorEvents` listeners receive `(error, safeContext)` — server-side
 * subscribers (e.g. autoFixer) can read full `error.context` for diagnostics,
 * but any subscriber that re-broadcasts to clients (e.g. `socket.js`) MUST
 * use `safeContext` to avoid leaking sensitive fields.
 */
export function emitErrorEvent(io, error, precomputedSafeContext) {
  const safeContext = precomputedSafeContext !== undefined
    ? precomputedSafeContext
    : sanitizeContext(error.context);

  errorEvents.emit('error', error, safeContext);

  // Broadcast to all connected clients
  io.emit('error:occurred', {
    message: error.message,
    code: error.code,
    status: error.status,
    severity: error.severity,
    timestamp: error.timestamp,
    context: safeContext,
    canAutoFix: error.canAutoFix
  });

  // If critical, also emit to system/health channel
  if (error.severity === 'critical') {
    io.emit('system:critical-error', {
      message: error.message,
      code: error.code,
      timestamp: error.timestamp,
      context: safeContext
    });
  }
}

/**
 * Middleware to handle errors with Socket.IO event emission
 * Use as the last middleware before the app listens
 */
export function errorMiddleware(err, req, res, next) {
  const io = req.app.get('io');
  const error = normalizeError(err);

  // Log the error
  const route = `${req.method} ${routePath(req)}`;
  const logMsg = `❌ Server error [${route}]: ${error.message}${causeSuffix(error)}`;
  if (error.status >= 500) {
    console.error(logMsg);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(logMsg);
  }

  // Emit the socket event and send the shared envelope — synchronous handlers
  // that throw a ServerError land here, not in asyncHandler, so both paths must
  // produce the same body.
  sendErrorResponse(res, error, { io });
}

/**
 * Handle unhandled promise rejections with Socket.IO broadcasting
 * Should be called with the io instance
 */
export function setupProcessErrorHandlers(io) {
  process.on('unhandledRejection', (reason, promise) => {
    const error = normalizeError(reason);
    error.severity = 'critical';

    console.error(`❌ Unhandled Promise Rejection: ${error.message}${causeSuffix(error)}`);
    if (reason instanceof Error) {
      console.error(reason.stack);
    }

    if (io) {
      emitErrorEvent(io, error);
    }
  });

  process.on('uncaughtException', (error) => {
    const serverError = normalizeError(error);
    serverError.severity = 'critical';
    serverError.canAutoFix = true; // Could be auto-fixable

    console.error(`💥 Uncaught Exception: ${serverError.message}`);
    // Guard the raw-throw deref — a non-Error throw value (e.g. `throw null`)
    // has no `.stack`, and the safety net itself must never throw while handling
    // a failure (it would mask the original and skip the clean exit/flush below).
    if (error instanceof Error) {
      console.error(error.stack);
    }

    if (io) {
      emitErrorEvent(io, serverError);
    }

    // Process is in undefined state after uncaught exception — must exit.
    // Use a short delay to allow the socket event to flush before exiting.
    setTimeout(() => process.exit(1), 100);
  });
}
