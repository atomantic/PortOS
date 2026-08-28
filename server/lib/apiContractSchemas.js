/**
 * Shared request contracts for externally callable PortOS APIs.
 *
 * Routes validate these schemas and OpenAPI converts the same schema objects
 * to JSON Schema, so runtime validation and published contracts cannot drift.
 */

import { z } from 'zod';

export const VOICE_TEXT_MAX_CHARS = 4000;

export const voiceSynthesizeBodySchema = z.object({
  text: z.string().trim().min(1).max(VOICE_TEXT_MAX_CHARS).describe('Text to synthesize; whitespace is trimmed.'),
  engine: z.enum(['kokoro', 'piper']).optional().describe('Speech engine. Defaults to the configured active engine.'),
  voice: z.string().max(128).optional().describe('Engine-specific voice identifier.'),
  rate: z.number().min(0.25).max(4).optional()
    .describe('Speech rate. Validated 0.25-4 (Piper). Kokoro clamps to 0.5-2.0.'),
}).strict();

export const sdapiTxt2imgBodySchema = z.object({
  prompt: z.string().min(1).max(8000).describe('Positive image prompt.'),
  negative_prompt: z.string().max(8000).optional().nullable().describe('Optional negative prompt; null clears it.'),
  width: z.number().int().min(64).max(2048).optional().describe('Output width in pixels.'),
  height: z.number().int().min(64).max(2048).optional().describe('Output height in pixels.'),
  steps: z.number().int().min(1).max(150).optional().describe('Sampling steps.'),
  cfg_scale: z.number().min(0).max(30).optional().describe('Classifier-free guidance scale.'),
  seed: z.number().int().optional().describe('Deterministic seed, when supported.'),
  sd_model_checkpoint: z.string().max(128).optional().describe('Optional model checkpoint identifier.'),
}).passthrough();

// Zod emits modern JSON Schema. OpenAPI 3.0 intentionally supports only a
// smaller dialect, so normalize the few constructs that occur in PortOS route
// contracts before publishing them. Keeping this conversion beside the Zod
// bridge makes runtime validation and both generated artifacts share one path.
const toOpenApi30 = (value) => {
  if (Array.isArray(value)) return value.map(toOpenApi30);
  if (!value || typeof value !== 'object') return value;

  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema')
      .map(([key, child]) => [key, toOpenApi30(child)]),
  );

  if (Array.isArray(normalized.type)) {
    const nonNullTypes = normalized.type.filter((type) => type !== 'null');
    if (nonNullTypes.length === 1 && nonNullTypes.length !== normalized.type.length) {
      normalized.type = nonNullTypes[0];
      normalized.nullable = true;
    }
  }

  if (normalized.const !== undefined) {
    normalized.enum = [normalized.const];
    delete normalized.const;
  }

  if (Array.isArray(normalized.anyOf)) {
    const nullIndex = normalized.anyOf.findIndex((schemaPart) => schemaPart?.type === 'null');
    if (nullIndex !== -1 && normalized.anyOf.length === 2) {
      const nonNull = normalized.anyOf[1 - nullIndex];
      if (nonNull && typeof nonNull === 'object') {
        Object.assign(normalized, nonNull, { nullable: true });
        delete normalized.anyOf;
      }
    }
  }

  return normalized;
};

export const zodToOpenApiSchema = (schema) => toOpenApi30(z.toJSONSchema(schema));
