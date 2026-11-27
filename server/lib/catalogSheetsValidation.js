// Zod request schemas for the catalog sheets routes.

import { z } from 'zod';

// Remove a universe-canon sheet pointer (the catalog-media sheets detach like
// any other media row). `variant` and the confirmed `filename` ride in the
// query string like the universe sheet DELETE.
export const removePointerSheetQuerySchema = z.object({
  variant: z.string().trim().min(1).max(48).optional(),
  filename: z.string().trim().min(1).max(255).optional(),
});
