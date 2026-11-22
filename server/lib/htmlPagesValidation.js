/**
 * Zod schemas for the HTML Pages bench routes: which models to run and how many pages to ask for.
 */

import { z } from 'zod';
import { localLlmModelIdSchema, localLlmRuntimeSchema } from './mediaValidation.js';
import { HTML_PAGES_MAX } from './htmlPageBench.js';

// Bounded so one request cannot queue an unbounded, hours-long sequence of generations the form never named.
export const HTML_PAGES_MAX_MODELS = 8;

export const htmlPagesRunSchema = z.object({
  models: z.array(z.object({ backend: localLlmRuntimeSchema, modelId: localLlmModelIdSchema }))
    .min(1).max(HTML_PAGES_MAX_MODELS)
    .refine((models) => new Set(models.map((m) => `${m.backend}:${m.modelId}`)).size === models.length, {
      message: 'each model may appear only once',
    }),
  pageCount: z.coerce.number().int().min(1).max(HTML_PAGES_MAX).optional(),
});
