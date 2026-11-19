/**
 * Zod schema for the LM Studio unload route.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

// POST /api/lmstudio/unload body — the single model to unload.
export const lmStudioModelIdSchema = z.object({
  modelId: z.string().trim().min(1),
});
