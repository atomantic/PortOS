/**
 * Zod schemas for the agent-tools feed and relevant-posts queries.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

export const agentToolsFeedQuerySchema = z.object({
  accountId: z.string().min(1),
  sort: z.enum(['hot', 'new', 'top', 'rising']).default('hot'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const agentToolsRelevantPostsQuerySchema = z.object({
  agentId: z.string().min(1),
  accountId: z.string().min(1),
  maxResults: z.coerce.number().int().min(1).max(100).default(10),
});
