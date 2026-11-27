// Zod request schemas for the image video models routes.

import { z } from 'zod';
import { ADDABLE_IMAGE_RUNNERS, ADDABLE_VIDEO_RUNTIMES } from './huggingfaceModel.js';

export const availabilitySchema = z.object({ enabled: z.boolean() }).strict();

export const supportRequestSchema = z.object({
  kind: z.enum(['image', 'video']),
  request: z.string().trim().min(3).max(4000),
}).strict();

// POST /install/huggingface — add a custom base model from an HF repo. Strict:
// the classifier refuses GGUF-only, wan/hunyuan, or unclassifiable repos so a
// bad add can't wedge the picker. The (multi-GB) weight download is deferred to
// the existing per-model download SSE once the entry exists — this call is
// metadata-only and returns the new entry. `kind`/`runtime`/`runner` are
// optional overrides for a mis-detected repo; `name`/`steps`/`guidance`
// override the derived defaults. HF token comes from settings/env — never the
// request body.
// runtime/runner enums are built from the classifier's ADDABLE_* allowlists —
// single source of truth so the route can't drift from what the classifier
// (and RUNNER_FAMILIES) actually accept.
export const hfAddModelSchema = z.object({
  url: z.string().min(1).max(1024),
  kind: z.enum(['image', 'video']).optional(),
  runtime: z.enum(ADDABLE_VIDEO_RUNTIMES).optional(),
  runner: z.enum(ADDABLE_IMAGE_RUNNERS).optional(),
  name: z.string().min(1).max(200).optional(),
  steps: z.coerce.number().int().min(1).max(200).optional(),
  guidance: z.coerce.number().min(0).max(30).optional(),
});

// PATCH /custom/:id — edit a user-added model's name/steps/guidance. Built-ins
// return 403 MODEL_READONLY.
export const patchModelSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  steps: z.coerce.number().int().min(1).max(200).optional(),
  guidance: z.coerce.number().min(0).max(30).optional(),
});
