/**
 * Zod schemas for the message sync, fetch, action, token-provider and inbox routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

// Express turns a repeated `?k=a&k=b` into an array; every field must be scalar
// before any cache read (#13150). Value leniency (bad/absent limit) stays in parsePagination.
export const messageInboxQuerySchema = z.object({
  accountId: z.string().optional(),
  search: z.string().optional(),
  summary: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

// Messages (routes/messages.js)
export const MESSAGE_TOKEN_PROVIDERS = ['outlook', 'teams'];
export const messageSyncBodySchema = z.object({ mode: z.enum(['unread', 'full']).optional() });
export const messageFetchFullBodySchema = z.object({ force: z.boolean().default(false) });
export const messageActionBodySchema = z.object({ action: z.enum(['archive', 'delete']) });
export const messageTokenProviderBodySchema = z.object({ provider: z.enum(MESSAGE_TOKEN_PROVIDERS).optional() });
