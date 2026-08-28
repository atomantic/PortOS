/**
 * Shared request contracts for externally callable PortOS APIs.
 *
 * Routes validate these schemas and OpenAPI converts the same schema objects
 * to JSON Schema, so runtime validation and published contracts cannot drift.
 */

import { z } from 'zod';

export const VOICE_TEXT_MAX_CHARS = 4000;

export const voiceSynthesizeBodySchema = z.object({
  text: z.string().trim().min(1).max(VOICE_TEXT_MAX_CHARS),
  engine: z.enum(['kokoro', 'piper']).optional(),
  voice: z.string().max(128).optional(),
  rate: z.number().min(0.25).max(4).optional()
    .describe('Speech rate. Validated 0.25-4 (Piper). Kokoro clamps to 0.5-2.0.'),
}).strict();

export const sdapiTxt2imgBodySchema = z.object({
  prompt: z.string().min(1).max(8000),
  negative_prompt: z.string().max(8000).optional().nullable(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfg_scale: z.number().min(0).max(30).optional(),
  seed: z.number().int().optional(),
  sd_model_checkpoint: z.string().max(128).optional(),
}).passthrough();

/**
 * Convert a Zod contract to plain JSON Schema (draft 2020-12, minus `$schema`).
 *
 * Stays JSON Schema on purpose. Consumers that need it are the AsyncAPI
 * document's `payload`, the CoS provider tool definitions, and the semantic
 * tool resource — all JSON Schema dialects. The OpenAPI 3.0.3 documents convert
 * at their own boundary via `toOpenApi30Operation`; doing it here instead
 * silently corrupts the other three (see `openapiDowngrade.js`).
 */
export const zodToOpenApiSchema = (schema) => {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
};
