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
 * Build the path portion of a request URL for logging — strips the query
 * string so tokens (e.g. `?access_token=…`) don't leak into server logs.
 * Falls back through `originalUrl` → `url` → '/'.
 */
const routePath = (req) => {
  const raw = req.originalUrl || req.url || '/';
  const qIndex = raw.indexOf('?');
  return qIndex === -1 ? raw : raw.slice(0, qIndex);
};

/**
 * Enhanced error object with metadata
 */
export class ServerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ServerError';
    this.status = options.status || 500;
    this.code = options.code || 'INTERNAL_ERROR';
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

      const safeContext = sanitizeContext(error.context);

      if (io) {
        emitErrorEvent(io, error, safeContext);
      }

      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        timestamp: error.timestamp,
        ...(safeContext && Object.keys(safeContext).length > 0 && { context: safeContext })
      });
    });
  };
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
function getErrorCode(status) {
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

  // Emit Socket.IO event
  if (io) {
    emitErrorEvent(io, error);
  }

  // Send response
  res.status(error.status).json({
    error: error.message,
    code: error.code,
    timestamp: error.timestamp
  });
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
    console.error(error.stack);

    if (io) {
      emitErrorEvent(io, serverError);
    }

    // Process is in undefined state after uncaught exception — must exit.
    // Use a short delay to allow the socket event to flush before exiting.
    setTimeout(() => process.exit(1), 100);
  });
}
