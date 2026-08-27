/**
 * Request schemas shared by API routes and OpenAPI generation.
 *
 * Keep this module dependency-light: route modules often import providers and
 * other services with expensive startup behavior, while spec generation must
 * be safe to run as a build step without booting PortOS or calling a provider.
 */

import { z } from 'zod';

// Maximum spoken-text length for both proactive speech and the public TTS API.
// The proactive service re-exports this as MAX_PROACTIVE_TEXT_LEN for its
// existing callers, so the bound has one owner without making this module
// depend on the service layer.
export const MAX_VOICE_TEXT_LEN = 4000;

export const synthesizeBodySchema = z.object({
  text: z.string().trim().min(1).max(MAX_VOICE_TEXT_LEN),
  engine: z.enum(['kokoro', 'piper']).optional(),
  voice: z.string().max(128).optional(),
  rate: z.number().min(0.25).max(4).optional()
    .describe('Speech rate. Validated 0.25–4 (Piper). Kokoro clamps to 0.5–2.0.'),
}).strict();

// A1111 clients commonly send fields PortOS does not need. Keep the route's
// compatibility posture by accepting those fields while documenting the
// known subset in the generated OpenAPI schema.
export const txt2imgSchema = z.object({
  prompt: z.string().min(1).max(8000),
  negative_prompt: z.string().max(8000).optional().nullable(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfg_scale: z.number().min(0).max(30).optional(),
  seed: z.number().int().optional(),
  sd_model_checkpoint: z.string().max(128).optional(),
}).passthrough();
