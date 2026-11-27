// Zod request schemas for the social accounts routes.

import { z } from 'zod';

export const listQuerySchema = z.object({
  platform: z.string().min(1).max(50).optional(),
  category: z.string().min(1).max(50).optional(),
});
