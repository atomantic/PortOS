// Zod request schemas for the conflict journal routes.

import { z } from 'zod';
import { boundedPaginationQuerySchema } from './queryValidation.js';

// Entries are only ever 'pending' (on archive) or 'resolved' (after the user
// restores/merges/discards); there is no 'dismissed' state — discard resolves
// the entry and DELETE hard-removes it. Don't advertise a status the resolver
// never produces.
export const listQuerySchema = boundedPaginationQuerySchema.extend({
  status: z.enum(['pending', 'resolved']).optional(),
});

export const resolveSchema = z.object({
  action: z.enum(['restore-all', 'merge-fields', 'discard']),
  fields: z.array(z.string().min(1).max(64)).max(50).optional(),
});
