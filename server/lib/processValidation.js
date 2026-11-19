/**
 * Zod schemas for the PM2 process, command-execution and workspace run routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { providerRefSchema } from './zodCompat.js';
import { MIN_TIMEOUT as AI_RUN_TIMEOUT_MIN_MS, MAX_TIMEOUT as AI_RUN_TIMEOUT_MAX_MS } from './aiToolkit/constants.js';
import { nonEmptyString, nullishString } from './sharedSchemas.js';

export const processListQuerySchema = z.object({ appId: z.string().min(1).optional() });

export const processActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
  appId: z.string().min(1).optional()
});

// Run command schema
export const runSchema = z.object({
  type: z.enum(['ai', 'command']),
  providerId: providerRefSchema.optional(),
  model: z.string().optional(),
  workspaceId: z.string(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  timeout: z.number().int().min(AI_RUN_TIMEOUT_MIN_MS).max(AI_RUN_TIMEOUT_MAX_MS).optional()
});

// timeoutMs bounds an operator command run (#12021); absent means unbounded,
// the right default for an interactive run the operator is watching.
export const commandExecuteBodySchema = z.object({
  command: nonEmptyString,
  workspacePath: nullishString,
  timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
});
