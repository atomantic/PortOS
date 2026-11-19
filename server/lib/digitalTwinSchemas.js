/**
 * Digital twin persistence and domain schemas, including `documentFilenameSchema` for safe Markdown
 * basenames across imports, federation and stored document access.
 *
 * Kept as a leaf module imported by services so `digitalTwinValidation.js` route schemas stay
 * isolated from the federated service graph.
 */

import { z } from 'zod';
import {
  COMM_DELTA_MIN,
  COMM_DELTA_MAX,
  BIG_FIVE_DELTA_MIN,
  BIG_FIVE_DELTA_MAX,
  EMOJI_USAGE_VALUES
} from './personaTraitBlend.js';
import { isSafeFilename } from './pathSafety.js';

// Document category enum
export const documentCategoryEnum = z.enum([
  'core',           // Core identity, values, philosophy
  'audio',          // Music, audio preferences
  'behavioral',     // Behavioral test suites
  'enrichment',     // Generated from enrichment Q&A
  'entertainment',  // Movies, books, TV, games
  'professional',   // Career, skills, work style
  'lifestyle',      // Routines, health, habits
  'social',         // Communication, relationships
  'creative'        // Aesthetic preferences, creative interests
]);

// Export format enum
// 'claude_md' is the pre-#4852 alias of 'agents_md' — kept so a persisted
// preference on an existing install still validates.
export const exportFormatEnum = z.enum(['system_prompt', 'agents_md', 'claude_md', 'json', 'individual']);

// Enrichment category enum
export const enrichmentCategoryEnum = z.enum([
  'core_memories',
  'favorite_books',
  'favorite_movies',
  'music_taste',
  'communication',
  'decision_making',
  'values',
  'aesthetics',
  'daily_routines',
  'career_skills',
  'non_negotiables',
  'decision_heuristics',
  'error_intolerance',
  'personality_assessments'
]);

// Imports and service callers may use existing peer document names (including
// spaces and uppercase extensions), but every document stays a Markdown basename.
export const documentFilenameSchema = z.string().min(1).refine(
  name => isSafeFilename(name, ['.md']) && !name.startsWith('.'),
  'Filename must be a safe markdown basename'
);

// Document metadata schema
export const documentMetaSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  title: z.string().min(1).max(200),
  category: documentCategoryEnum,
  version: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).default(0),
  weight: z.number().int().min(1).max(10).default(5),
  // When this document was (re-)created, and when it was last edited. Both are
  // optional because documents predating #3530 — and any rebuilt by
  // digital-twin-meta's disk scan — carry no stamp. They exist so a document
  // re-created (or edited) after a delete supersedes the older
  // `deletedDocuments` tombstone during peer sync instead of being reaped.
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

// Tombstone for a deleted Digital Twin document (#3530). Keyed on `filename`,
// NOT the document id: ids are minted per-install (`generateId`), so the same
// logical document can carry a different id on each machine — filename is the
// only identifier every peer agrees on (it is also what `mergeMeta` unions
// documents by, and what the `.md` file on disk is named).
export const deletedDocumentSchema = z.object({
  filename: z.string().min(1),
  deletedAt: z.string().min(1)
});

// Test history entry schema. personaId/personaName are present only when the
// run embodied a persona (P7); older entries predate the field, so both are
// optional — Zod strips unknown keys, so they MUST be declared here or they'd
// be silently dropped on the next loadMeta.
export const testHistoryEntrySchema = z.object({
  runId: z.string().guid(),
  providerId: z.string(),
  model: z.string(),
  personaId: z.string().guid().optional(),
  personaName: z.string().optional(),
  score: z.number().min(0).max(1),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  partial: z.number().int().min(0),
  total: z.number().int().min(0),
  timestamp: z.string().datetime()
});

// Values-alignment run history entry (M34 P6). Same persona fields as above.
export const valuesTestHistoryEntrySchema = z.object({
  runId: z.string().guid(),
  providerId: z.string(),
  model: z.string(),
  personaId: z.string().guid().optional(),
  personaName: z.string().optional(),
  score: z.number().min(0).max(1),
  aligned: z.number().int().min(0),
  partial: z.number().int().min(0),
  misaligned: z.number().int().min(0),
  total: z.number().int().min(0),
  timestamp: z.string().datetime()
});

// Adversarial-boundary run history entry (M34 P6). Same persona fields as above.
export const adversarialTestHistoryEntrySchema = z.object({
  runId: z.string().guid(),
  providerId: z.string(),
  model: z.string(),
  personaId: z.string().guid().optional(),
  personaName: z.string().optional(),
  score: z.number().min(0).max(1),
  held: z.number().int().min(0),
  partial: z.number().int().min(0),
  breached: z.number().int().min(0),
  total: z.number().int().min(0),
  timestamp: z.string().datetime()
});

// Multi-turn conversation run history entry (M34 P6). Same persona fields as above.
export const multiTurnTestHistoryEntrySchema = z.object({
  runId: z.string().guid(),
  providerId: z.string(),
  model: z.string(),
  personaId: z.string().guid().optional(),
  personaName: z.string().optional(),
  score: z.number().min(0).max(1),
  consistent: z.number().int().min(0),
  partial: z.number().int().min(0),
  inconsistent: z.number().int().min(0),
  total: z.number().int().min(0),
  timestamp: z.string().datetime()
});

// Enrichment progress schema
export const enrichmentProgressSchema = z.object({
  completedCategories: z.array(enrichmentCategoryEnum).default([]),
  lastSession: z.string().datetime().nullable().optional(),
  questionsAnswered: z.record(enrichmentCategoryEnum, z.number().int().min(0)).optional(),
  scaleQuestionsAnswered: z.record(z.string(), z.number().int().min(1).max(5)).optional()
});

// Digital Twin settings schema
export const digitalTwinSettingsSchema = z.object({
  autoInjectToCoS: z.boolean().default(true),
  maxContextTokens: z.number().int().min(1000).max(100000).default(4000),
  // Global gate for injecting Privacy Vault identity facts into twin/CoS prompts
  // (issue #2147). Default false — PII sharing is opt-in twice (this global
  // toggle AND the per-record share_with_twin flag).
  includePrivacyContext: z.boolean().default(false),
  // The persona currently driving the embodied-twin context (CoS agents, etc.).
  // null/absent = no persona (base twin). Tolerate the UI sentinel for "deactivate".
  activePersonaId: z.string().guid().nullable().optional()
});
export const soulSettingsSchema = digitalTwinSettingsSchema; // Alias for backwards compatibility

// --- Phase 7: Twin Personas (M34 P7) ---

// Trait-blending rules (M34 P7). Beyond free-text instructions, a persona may
// modulate the *base* twin's quantitative profile for its context: relative
// nudges to formality/verbosity (the 1..10 communicationProfile scale, so a
// ±9 delta can reach either end), absolute overrides for emoji usage and tone,
// and directional Big-Five leans (0..1 scale → ±1 delta). All fields optional;
// an instructions-only persona omits the whole object. The blend + directive
// rendering live in `server/lib/personaTraitBlend.js`, which is the single
// source for the delta bounds the schema and UI sliders both enforce.
const bigFiveDelta = z.number().min(BIG_FIVE_DELTA_MIN).max(BIG_FIVE_DELTA_MAX);
export const personaTraitAdjustmentsSchema = z.object({
  formality: z.number().int().min(COMM_DELTA_MIN).max(COMM_DELTA_MAX).optional(),
  verbosity: z.number().int().min(COMM_DELTA_MIN).max(COMM_DELTA_MAX).optional(),
  emojiUsage: z.enum(EMOJI_USAGE_VALUES).optional(),
  tone: z.string().max(100).optional(),
  bigFive: z.object({
    O: bigFiveDelta.optional(),
    C: bigFiveDelta.optional(),
    E: bigFiveDelta.optional(),
    A: bigFiveDelta.optional(),
    N: bigFiveDelta.optional()
  }).optional()
});

// A persona is a named context variant. Its instructions are prepended to the
// twin context so the embodied twin modulates voice/behavior for a context
// (Professional, Casual, Family, …) without forking the underlying documents.
export const personaSchema = z.object({
  id: z.string().guid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  instructions: z.string().min(1).max(5000),
  traitAdjustments: personaTraitAdjustmentsSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Tombstone for a deleted persona (#3533). Keyed on `id`, unlike the document
// tombstone above: a persona id is minted ONCE by the machine that created the
// persona and then travels with the record through peer sync (mergeMeta unions
// personas by id), so every peer agrees on it. `id` is a plain non-empty string
// rather than a guid so a tombstone for a legacy/hand-edited persona id still
// normalizes instead of failing the whole meta parse.
export const deletedPersonaSchema = z.object({
  id: z.string().min(1),
  deletedAt: z.string().min(1)
});

export const createPersonaInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  instructions: z.string().min(1).max(5000),
  traitAdjustments: personaTraitAdjustmentsSchema.optional()
});

export const updatePersonaInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().min(1).max(5000).optional(),
  // nullable so the UI can clear adjustments back to an instructions-only persona
  traitAdjustments: personaTraitAdjustmentsSchema.nullable().optional()
});

export const setActivePersonaInputSchema = z.object({
  personaId: z.string().guid().nullable()
});

// --- Phase 1: Quantitative Personality Modeling Schemas ---

// Big Five personality traits (OCEAN model)
export const bigFiveSchema = z.object({
  O: z.number().min(0).max(1).describe('Openness to experience'),
  C: z.number().min(0).max(1).describe('Conscientiousness'),
  E: z.number().min(0).max(1).describe('Extraversion'),
  A: z.number().min(0).max(1).describe('Agreeableness'),
  N: z.number().min(0).max(1).describe('Neuroticism')
});

// Communication profile schema
export const communicationProfileSchema = z.object({
  formality: z.number().int().min(1).max(10).describe('1=very casual, 10=very formal'),
  verbosity: z.number().int().min(1).max(10).describe('1=terse, 10=elaborate'),
  avgSentenceLength: z.number().min(5).max(50).optional(),
  emojiUsage: z.enum(EMOJI_USAGE_VALUES).default('rare'),
  preferredTone: z.string().max(100).optional(),
  distinctiveMarkers: z.array(z.string().max(200)).max(10).optional()
});

// Valued trait with priority
export const valuedTraitSchema = z.object({
  value: z.string().min(1).max(100),
  priority: z.number().int().min(1).max(10),
  description: z.string().max(500).optional(),
  conflictsWith: z.array(z.string()).optional()
});

// Full traits schema
export const traitsSchema = z.object({
  bigFive: bigFiveSchema.optional(),
  valuesHierarchy: z.array(valuedTraitSchema).max(20).optional(),
  communicationProfile: communicationProfileSchema.optional(),
  lastAnalyzed: z.string().datetime().optional(),
  analysisVersion: z.string().optional()
});

// --- Phase 2: Confidence Scoring Schemas ---

// Confidence dimension enum
export const confidenceDimensionEnum = z.enum([
  'openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism',
  'values', 'communication', 'decision_making', 'boundaries', 'identity'
]);

// Gap recommendation
export const gapRecommendationSchema = z.object({
  dimension: confidenceDimensionEnum,
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().min(0),
  requiredEvidence: z.number().int().min(1),
  suggestedQuestions: z.array(z.string().max(500)).max(5),
  suggestedCategory: enrichmentCategoryEnum.optional()
});

// Full confidence schema
export const confidenceSchema = z.object({
  overall: z.number().min(0).max(1),
  dimensions: z.record(confidenceDimensionEnum, z.number().min(0).max(1)),
  gaps: z.array(gapRecommendationSchema),
  lastCalculated: z.string().datetime().optional()
});

// Full meta.json schema
export const digitalTwinMetaSchema = z.object({
  version: z.string().default('1.0.0'),
  documents: z.array(documentMetaSchema).default([]),
  deletedDocuments: z.array(deletedDocumentSchema).default([]),
  testHistory: z.array(testHistoryEntrySchema).default([]),
  valuesTestHistory: z.array(valuesTestHistoryEntrySchema).default([]),
  adversarialTestHistory: z.array(adversarialTestHistoryEntrySchema).default([]),
  multiTurnTestHistory: z.array(multiTurnTestHistoryEntrySchema).default([]),
  enrichment: enrichmentProgressSchema.default({ completedCategories: [], lastSession: null }),
  settings: digitalTwinSettingsSchema.default({ autoInjectToCoS: true, maxContextTokens: 4000, includePrivacyContext: false }),
  personas: z.array(personaSchema).default([]),
  deletedPersonas: z.array(deletedPersonaSchema).default([]),
  traits: traitsSchema.optional(),
  confidence: confidenceSchema.optional()
});
export const soulMetaSchema = digitalTwinMetaSchema; // Alias for backwards compatibility

