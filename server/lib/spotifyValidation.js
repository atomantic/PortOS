// Zod request schemas for the spotify routes.

import { z } from 'zod';

export const spotifyCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});
