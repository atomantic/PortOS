import { z } from 'zod';

// =============================================================================
// SOCKET EVENT SCHEMAS
// =============================================================================

// detect:start — path to scan
export const detectStartSchema = z.object({
  path: z.string().min(1, 'path is required')
});

// standardize:start — repo path and optional provider
export const standardizeStartSchema = z.object({
  repoPath: z.string().min(1, 'repoPath is required'),
  providerId: z.string().min(1).optional()
});

// logs:subscribe — process name and optional line count
export const logsSubscribeSchema = z.object({
  processName: z.string().min(1, 'processName is required'),
  lines: z.number().int().positive().max(10000).default(100)
});

// error:recover — error code and context
export const errorRecoverSchema = z.object({
  code: z.string().min(1, 'error code is required'),
  context: z.record(z.unknown()).optional().default({})
});

// shell:input — session ID and input data
export const shellInputSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  data: z.string()
});

// shell:resize — session ID with cols and rows
export const shellResizeSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(500)
});

// shell:stop — session ID
export const shellStopSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required')
});

// app:update — app ID for pull/install/restart cycle
export const appUpdateSchema = z.object({
  appId: z.string().min(1, 'appId is required')
});

// app:standardize — app ID for PM2 standardization
export const appStandardizeSchema = z.object({
  appId: z.string().min(1, 'appId is required')
});

// =============================================================================
// VALIDATION HELPER
// =============================================================================

/**
 * Validate socket event data against a Zod schema.
 * Emits `${event}:error` on failure and returns null.
 * Returns the parsed (and defaulted) data on success.
 */
export function validateSocketData(schema, data, socket, event) {
  const result = schema.safeParse(data);
  if (!result.success) {
    socket.emit(`${event}:error`, {
      message: 'Validation failed',
      details: result.error.issues.map(i => ({
        path: i.path.join('.'),
        message: i.message
      }))
    });
    return null;
  }
  return result.data;
}
