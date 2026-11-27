// Zod request schemas for the remote desktop viewer routes.

import { z } from 'zod';

// A repeated `token` parameter arrives as an array; refuse it rather than let
// the broker see a non-string.
export const viewerQuerySchema = z.object({ token: z.string().max(512).optional() });
