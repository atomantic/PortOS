// Zod request schemas for the tools routes.

import { z } from 'zod';

export const toolIdSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Tool ID must contain only alphanumeric characters, hyphens, and underscores');

export const registerToolSchema = z.object({
  id: toolIdSchema.optional(),
  name: z.string().min(1).max(100),
  category: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  promptHints: z.string().max(1000).optional()
});

export const updateToolSchema = registerToolSchema.omit({ id: true }).partial();
