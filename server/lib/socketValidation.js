import { z } from 'zod';

// =============================================================================
// SOCKET EVENT SCHEMAS
// =============================================================================

// detect:start — path to scan
export const detectStartSchema = z.object({
  path: z.string().min(1, 'path is required')
});

// standardize:start — repo path and optional provider.
// `overwriteEcosystem: true` is the explicit opt-in to regenerate an existing,
// non-PortOS-generated ecosystem.config.cjs (default false preserves it).
export const standardizeStartSchema = z.object({
  repoPath: z.string().min(1, 'repoPath is required'),
  providerId: z.string().min(1).optional(),
  overwriteEcosystem: z.boolean().optional()
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

// Shared session ID schema for shell operations
export const shellSessionIdSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required')
});

// shell:attach — session id + optional claim flag.
// `claim: true` means "attach only if currently unattached or already mine" — used by
// auto-pick paths so a multi-tab race doesn't displace another tab. Default (false)
// preserves the manual-attach takeover semantics (deep-link / tab-click intent).
export const shellAttachSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  claim: z.boolean().optional()
});

// shell:stop — session ID
export const shellStopSchema = shellSessionIdSchema;

// app:update — app ID for pull/install/restart cycle
export const appUpdateSchema = z.object({
  appId: z.string().min(1, 'appId is required')
});

// app:standardize — app ID for PM2 standardization.
// `overwriteEcosystem: true` is the explicit opt-in to regenerate an existing,
// non-PortOS-generated ecosystem.config.cjs (default false preserves it).
export const appStandardizeSchema = z.object({
  appId: z.string().min(1, 'appId is required'),
  overwriteEcosystem: z.boolean().optional()
});

// app:deploy — app ID and optional flags for Xcode deploy
import { DEPLOY_FLAGS } from '../services/appDeployer.js';
const appDeployFlagSchema = z.enum(DEPLOY_FLAGS, {
  errorMap: () => ({ message: `flag must be one of: ${DEPLOY_FLAGS.join(', ')}` })
});

export const appDeploySchema = z.object({
  appId: z.string().min(1, 'appId is required'),
  flags: z.array(appDeployFlagSchema).max(20, 'no more than 20 flags are allowed').default([])
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
