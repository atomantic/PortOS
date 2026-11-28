// Zod request schemas for the ask routes.

import { z } from 'zod';
import { VALID_MODES, ID_RE as CONV_ID_RE } from './askConversationIds.js';

// Sourced from `askConversations.ID_RE` so the route, the storage layer, and
// the generator are guaranteed to agree on the canonical id shape — variable-
// width regexes here let non-canonical ids through and break listConversations'
// lexical-sort = chronological-sort invariant.
export const idSchema = z.string().regex(CONV_ID_RE, 'invalid conversation id');

export const askBodySchema = z.object({
  conversationId: idSchema.optional(),
  question: z.string().trim().min(1).max(4000),
  mode: z.enum([...VALID_MODES]).optional().default('ask'),
  providerId: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
  maxSources: z.number().int().min(1).max(50).optional().default(12),
  timeWindow: z.object({
    days: z.number().int().min(1).max(365).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  }).refine(
    (w) => !(w.startDate && w.endDate) || Date.parse(w.startDate) <= Date.parse(w.endDate),
    { message: 'startDate must be <= endDate', path: ['startDate'] },
  ).optional(),
});

export const promoteBodySchema = z.object({
  promoted: z.boolean().optional().default(true),
});

// Promote-turn payloads vary by target — keep the discriminated union narrow
// rather than a permissive bag so the route can fail-fast on a goal target
// missing its goalId before we touch any service.
export const promoteTurnBodySchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('brain') }),
  z.object({ target: z.literal('task'), priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().default('MEDIUM') }),
  z.object({ target: z.literal('goal'), goalId: z.string().min(1).max(200) }),
]);
