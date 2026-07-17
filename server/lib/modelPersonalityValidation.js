/**
 * Model Personality validation schemas (issue #2610).
 *
 * Zod schemas for the LLM personality self-profile test: the structured
 * self-evaluation response, the twin-alignment scorer response, and the
 * route input/settings shapes. Kept a LEAF module (zod only — no imports
 * from other PortOS modules) so mocked suites never drag transitive deps.
 *
 * The trait taxonomy is versioned: `PERSONALITY_TAXONOMY_VERSION` is stamped
 * on every persisted result so a future taxonomy change can distinguish old
 * records instead of silently comparing scores across different trait sets.
 */

import { z } from 'zod';

// Trait taxonomy v1 — the single source of truth for the self-profile JSON
// keys. The prompt template receives this list via `{{traitKeys}}` so the
// schema and the prompt can never drift apart.
export const PERSONALITY_TRAIT_KEYS = [
  'agreeableness',
  'humor',
  'errorAversion',
  'selfCensorship',
  'conciseness',
  'dogmatism',
  'sycophancy',
  'creativity',
  'formality',
  'empathy'
];

export const PERSONALITY_TAXONOMY_VERSION = 1;

const score01 = z.number().min(0).max(1);

// One self-reported trait: a 0–1 score plus a short self-observation.
export const personalityTraitEntrySchema = z.object({
  score: score01,
  rationale: z.string().max(2000).optional().default('')
});

// Call 1 (self-profile) response — every taxonomy key must be present so a
// partial answer retries through the runner's schema machinery instead of
// persisting a half-scored profile.
export const personalityProfileResponseSchema = z.object({
  traits: z.object(
    Object.fromEntries(PERSONALITY_TRAIT_KEYS.map((k) => [k, personalityTraitEntrySchema]))
  ),
  summary: z.string().max(4000).optional().default('')
});

// Call 2 (alignment scorer) response — dimension keys are free-form (the
// scorer names whichever twin dimensions it found evidence for).
export const personalityAlignmentResponseSchema = z.object({
  alignmentScore: score01,
  dimensions: z
    .record(
      z.string(),
      z.object({
        score: score01,
        note: z.string().max(1000).optional().default('')
      })
    )
    .optional()
    .default({})
});

// POST /api/model-personality/run
export const runPersonalityTestInputSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1).optional(),
  includeAlignment: z.boolean().optional(),
  personaId: z.string().min(1).nullable().optional()
});

// GET /api/model-personality/history
export const personalityHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional()
});

// UI selects submit '' for "no scorer configured" — normalize to null (clear).
const emptyToNull = (v) => (v === '' ? null : v);

// PUT /api/model-personality/settings — partial update, no defaults so an
// omitted key never overwrites the stored value.
export const personalitySettingsUpdateSchema = z.object({
  scorerProviderId: z.preprocess(emptyToNull, z.string().min(1).nullable()).optional(),
  scorerModel: z.preprocess(emptyToNull, z.string().min(1).nullable()).optional(),
  historyCap: z.number().int().min(1).max(1000).optional(),
  defaultIncludeAlignment: z.boolean().optional()
});
