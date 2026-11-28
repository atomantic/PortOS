// Zod request schemas for the mind tool recipe routes routes.

import { z } from 'zod';

export const recipeIdSchema = z.object({ recipeId: z.uuid() });
