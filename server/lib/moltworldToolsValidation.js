// Zod request schemas for the moltworld tools routes.

import { z } from 'zod';

export const accountQuerySchema = z.object({ accountId: z.string().min(1).max(200) });
