// Zod request schemas for the import routes.

import { z } from 'zod';
import { documentFilenameSchema } from './digitalTwinValidation.js';

export const importSaveSchema = z.object({
  source: z.string().min(1),
  suggestedDoc: z.object({
    filename: documentFilenameSchema,
    content: z.string().min(1),
    title: z.string().optional(),
    category: z.string().optional(),
  }),
});

export const spotifyBrowserImportSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});
