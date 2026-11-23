/**
 * Zod schemas for the HTML Pages bench routes: which local models and provider routes to run and the brief for each page.
 */

import { z } from 'zod';
import { localLlmModelIdSchema, localLlmRuntimeSchema } from './mediaValidation.js';
import { HTML_BRIEF_MAX_CHARS, HTML_PAGES_MAX } from './htmlPageBench.js';
import { EFFORT_LEVELS } from './provider/providerModels.js';

// Bounded so one request cannot queue an unbounded, hours-long sequence of generations the form never named.
export const HTML_PAGES_MAX_MODELS = 8;

const emptyToNull = (v) => (v === '' ? null : v);

// Any configured provider, model and effort: the picker's `{ providerId, model, effort }` triple. A blank model runs the provider's default.
const htmlPagesRouteSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  model: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  effort: z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional()),
});

// A llama.cpp LoRA adapter the server has loaded, by its `/lora-adapters` id, and how strongly to apply it. Absent or null runs the base model.
const loraPickSchema = z.object({
  id: z.number().int().min(0).max(64),
  scale: z.number().min(0).max(2).default(1),
}).nullable().optional();

// The same weights with and without an adapter are two different picks.
const modelKey = (m) => `${m.backend}:${m.modelId}:${m.lora ? `${m.lora.id}@${m.lora.scale}` : ''}`;

const routeKey = (r) => `${r.providerId}:${r.model ?? ''}:${r.effort ?? ''}`;

export const htmlPagesRunSchema = z.object({
  models: z.array(z.object({ backend: localLlmRuntimeSchema, modelId: localLlmModelIdSchema, lora: loraPickSchema })
    .refine((m) => !m.lora || m.backend === 'llama', { message: 'a LoRA adapter applies only to a llama.cpp model', path: ['lora'] }))
    .max(HTML_PAGES_MAX_MODELS).default([])
    .refine((models) => new Set(models.map(modelKey)).size === models.length, {
      message: 'each model may appear only once',
    }),
  routes: z.array(htmlPagesRouteSchema).max(HTML_PAGES_MAX_MODELS).default([])
    .refine((routes) => new Set(routes.map(routeKey)).size === routes.length, { message: 'each provider route may appear only once' }),
  // One entry per page, sent to every model verbatim between PortOS's fixed standalone-file rules. Over-long text is refused with a count, never cut.
  pages: z.array(z.string().max(HTML_BRIEF_MAX_CHARS).refine((brief) => brief.trim().length > 0, 'a page brief cannot be blank')).min(1).max(HTML_PAGES_MAX),
}).refine((body) => body.models.length + body.routes.length >= 1, { message: 'pick at least one model', path: ['models'] })
  .refine((body) => body.models.length + body.routes.length <= HTML_PAGES_MAX_MODELS, { message: `at most ${HTML_PAGES_MAX_MODELS} models per run`, path: ['models'] });

// One stored page by run id and zero-based page number, for its file download and path.
export const htmlPagesPageParamsSchema = z.object({
  id: z.string().regex(/^htmlpages-[0-9a-f-]{36}$/, 'not an HTML pages run id'),
  index: z.coerce.number().int().min(0).max(HTML_PAGES_MAX - 1),
});
