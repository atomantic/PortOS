// Zod request schemas for the data maintenance routes.

import { z } from 'zod';

export const paramsSchema = z.object({ operationId: z.string().min(1).max(100) });
