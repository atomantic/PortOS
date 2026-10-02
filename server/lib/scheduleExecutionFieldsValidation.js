import { z } from 'zod';
import { providerRefFieldSchema } from './zodCompat.js';

// Optional fields preserve omitted values; null/empty selections clear overrides.
export const scheduleExecutionFieldsSchema = z.object({
  prompt: z.string().nullable().optional(),
  providerId: providerRefFieldSchema.nullable().optional(),
  model: z.string().nullable().optional(),
});
