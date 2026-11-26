/** Shared request schemas for the command palette routes. */
import { z } from 'zod';

export const manifestQuerySchema = z.object({
  actionsOnly: z.enum(['0', '1', 'true', 'false']).optional(),
});

export const actionBodySchema = z.object({
  args: z.record(z.any()).optional().default({}),
});
