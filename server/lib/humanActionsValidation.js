// Zod request schemas for the human actions routes.

import { z } from 'zod';

export const listQuerySchema = z.object({
  planKey: z.string().trim().min(1).max(40).optional(),
  includeDone: z.enum(['true', 'false']).optional(),
}).strict();
