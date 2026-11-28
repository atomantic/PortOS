// Zod request schemas for the brain import routes.

import { z } from 'zod';

export const previewSchema = z.object({
  data: z.unknown()
});

export const importSchema = z.object({
  data: z.unknown(),
  tags: z.array(z.string().min(1).max(50)).max(10).optional(),
  skipEmpty: z.boolean().optional()
});
