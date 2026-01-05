/**
 * Error handling utilities for graceful server error management
 * Catches errors in async routes and emits Socket.IO events for UI alerting
 */

import { EventEmitter } from 'events';

// Global error event emitter for broadcasting errors
export const errorEvents = new EventEmitter();

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
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      const io = req.app.get('io');
      const error = normalizeError(err);

      // Log the error
      const logMsg = `❌ Route error: ${error.message}`;
      if (error.status >= 500) {
        console.error(logMsg, error.stack ? error.stack : '');
      } else {
        console.error(logMsg);
      }

      // Emit Socket.IO event for UI notification
      if (io) {
        emitErrorEvent(io, error);
      }

      // Send error response
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        timestamp: error.timestamp,
        ...(error.context && Object.keys(error.context).length > 0 && { context: error.context })
      });
    });
  };
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
    return new ServerError(err.message, {
      status,
      code,
      context: { originalError: err.constructor.name }
    });
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
 * Emit error event via Socket.IO to alert UI
 */
export function emitErrorEvent(io, error) {
  errorEvents.emit('error', error);

  // Broadcast to all connected clients
  io.emit('error:occurred', {
    message: error.message,
    code: error.code,
    status: error.status,
    severity: error.severity,
    timestamp: error.timestamp,
    context: error.context,
    canAutoFix: error.canAutoFix
  });

  // If critical, also emit to system/health channel
  if (error.severity === 'critical') {
    io.emit('system:critical-error', {
      message: error.message,
      code: error.code,
      timestamp: error.timestamp,
      context: error.context
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
  const logMsg = `❌ Server error: ${error.message}`;
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

    console.error(`❌ Unhandled Promise Rejection: ${error.message}`);
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

    // Exit after broadcasting critical error
    process.exit(1);
  });
}
