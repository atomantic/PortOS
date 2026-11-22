/**
 * Zod schemas for the HTML Pages bench routes: which models to run and the brief for each page.
 */

import { z } from 'zod';
import { localLlmModelIdSchema, localLlmRuntimeSchema } from './mediaValidation.js';
import { HTML_BRIEF_MAX_CHARS, HTML_PAGES_MAX } from './htmlPageBench.js';

// Bounded so one request cannot queue an unbounded, hours-long sequence of generations the form never named.
export const HTML_PAGES_MAX_MODELS = 8;

export const htmlPagesRunSchema = z.object({
  models: z.array(z.object({ backend: localLlmRuntimeSchema, modelId: localLlmModelIdSchema }))
    .min(1).max(HTML_PAGES_MAX_MODELS)
    .refine((models) => new Set(models.map((m) => `${m.backend}:${m.modelId}`)).size === models.length, {
      message: 'each model may appear only once',
    }),
  // One entry per page, sent to every model verbatim between PortOS's fixed standalone-file rules. Over-long text is refused with a count, never cut.
  pages: z.array(z.string().max(HTML_BRIEF_MAX_CHARS).refine((brief) => brief.trim().length > 0, 'a page brief cannot be blank')).min(1).max(HTML_PAGES_MAX),
});
