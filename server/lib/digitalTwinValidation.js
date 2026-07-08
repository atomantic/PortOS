import { z } from 'zod';
import {
  COMM_DELTA_MIN,
  COMM_DELTA_MAX,
  BIG_FIVE_DELTA_MIN,
  BIG_FIVE_DELTA_MAX,
  EMOJI_USAGE_VALUES
} from './personaTraitBlend.js';
import { partialWithoutDefaults } from './zodCompat.js';

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

// Test result enum
export const testResultEnum = z.enum(['passed', 'partial', 'failed', 'pending']);

// Values-alignment result enum (M34 P6)
export const valuesTestResultEnum = z.enum(['aligned', 'partial', 'misaligned', 'pending']);

// Adversarial-boundary result enum (M34 P6) — did the twin hold the line?
export const adversarialTestResultEnum = z.enum(['held', 'partial', 'breached', 'pending']);

// Export format enum
export const exportFormatEnum = z.enum(['system_prompt', 'claude_md', 'json', 'individual']);

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

// Document metadata schema
export const documentMetaSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  title: z.string().min(1).max(200),
  category: documentCategoryEnum,
  version: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).default(0),
  weight: z.number().int().min(1).max(10).default(5)
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

// Individual test result schema
export const testResultSchema = z.object({
  testId: z.number().int().min(1),
  testName: z.string(),
  prompt: z.string(),
  expectedBehavior: z.string(),
  failureSignals: z.string(),
  response: z.string().optional(),
  result: testResultEnum,
  reasoning: z.string().optional()
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
  testHistory: z.array(testHistoryEntrySchema).default([]),
  valuesTestHistory: z.array(valuesTestHistoryEntrySchema).default([]),
  adversarialTestHistory: z.array(adversarialTestHistoryEntrySchema).default([]),
  multiTurnTestHistory: z.array(multiTurnTestHistoryEntrySchema).default([]),
  enrichment: enrichmentProgressSchema.default({ completedCategories: [], lastSession: null }),
  settings: digitalTwinSettingsSchema.default({ autoInjectToCoS: true, maxContextTokens: 4000, includePrivacyContext: false }),
  personas: z.array(personaSchema).default([]),
  traits: traitsSchema.optional(),
  confidence: confidenceSchema.optional()
});
export const soulMetaSchema = digitalTwinMetaSchema; // Alias for backwards compatibility

// --- Input schemas for API endpoints ---

// Create document input
export const createDocumentInputSchema = z.object({
  filename: z.string().min(1).max(100).regex(/^[\w\-]+\.md$/, 'Filename must be a valid markdown filename'),
  title: z.string().min(1).max(200),
  category: documentCategoryEnum,
  content: z.string().min(1).max(1000000),
  enabled: z.boolean().optional().default(true),
  priority: z.number().int().min(0).optional().default(0)
});

// Update document input
export const updateDocumentInputSchema = z.object({
  content: z.string().min(1).max(1000000).optional(),
  title: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
  weight: z.number().int().min(1).max(10).optional()
});

// testIds is "all tests" when absent. The client API wrappers default the
// argument to `null` (not `undefined`), so tolerate the null sentinel —
// `.optional()` alone rejects `null` and would 400 a "run all" request.
const optionalTestIds = z.preprocess(
  v => v == null ? undefined : v,
  z.array(z.number().int().min(1)).optional()
);

// Optional persona to embody for a test run. The UI's "Base twin" choice sends
// '' (or omits it); a specific persona sends its uuid. Treat null/'' as absent
// so a base-twin run validates instead of 400-ing on the sentinel.
const optionalPersonaId = z.preprocess(
  v => (v == null || v === '') ? undefined : v,
  z.string().guid().optional()
);

// Run tests input
export const runTestsInputSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  testIds: optionalTestIds,
  personaId: optionalPersonaId
});

// Run multi-model tests input
export const runMultiTestsInputSchema = z.object({
  providers: z.array(z.object({
    providerId: z.string().min(1),
    model: z.string().min(1)
  })).min(1).max(10),
  testIds: optionalTestIds,
  personaId: optionalPersonaId
});

// Enrichment question input
export const enrichmentQuestionInputSchema = z.object({
  category: enrichmentCategoryEnum,
  providerOverride: z.string().optional(),
  modelOverride: z.string().optional(),
  skipIndices: z.array(z.number().int()).optional()
});

// Enrichment answer input
export const enrichmentAnswerInputSchema = z.object({
  questionId: z.string().guid(),
  category: enrichmentCategoryEnum,
  question: z.string().min(1),
  answer: z.string().min(1).max(10000).optional(),
  scaleValue: z.number().int().min(1).max(5).optional(),
  questionType: z.enum(['text', 'scale']).default('text'),
  scaleQuestionId: z.string().optional(),
  providerOverride: z.string().optional(),
  modelOverride: z.string().optional()
}).refine(
  data => (data.questionType === 'text' && data.answer) ||
          (data.questionType === 'scale' && data.scaleValue != null),
  { message: 'Text questions require answer; scale questions require scaleValue' }
).refine(
  data => data.questionType !== 'scale' || data.scaleQuestionId,
  { message: 'Scale questions require scaleQuestionId' }
);

// Export input
export const exportInputSchema = z.object({
  format: exportFormatEnum,
  documentIds: z.array(z.string()).optional(),
  includeDisabled: z.boolean().optional().default(false)
});

// Settings update input
export const settingsUpdateInputSchema = partialWithoutDefaults(soulSettingsSchema);

// Test history query
export const testHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(10)
});

// Contradiction detection input
export const contradictionInputSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1)
});

// Dynamic test generation input
export const generateTestsInputSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1)
});

// Writing sample analysis input
export const writingAnalysisInputSchema = z.object({
  samples: z.array(z.string().min(10)).min(1).max(10),
  providerId: z.string().min(1),
  model: z.string().min(1)
});

// Spoken-vs-written style comparison input (M34 P5 — multi-modal capture).
// writtenSamples is optional: when omitted the service falls back to the
// user's enabled twin documents.
export const spokenWrittenStyleInputSchema = z.object({
  spokenTranscript: z.string().min(100).max(50000),
  writtenSamples: z.array(z.string().min(10).max(20000)).max(10).optional(),
  providerId: z.string().min(1),
  model: z.string().min(1)
});

// Image identity-source input (M34 P5 — multi-modal capture). A base64 image
// data URL plus the vision-capable provider/model. The data URL is capped well
// under the server's 55mb JSON body limit (~15M chars ≈ 11MB of image bytes).
export const identityImageInputSchema = z.object({
  imageDataUrl: z.string()
    .max(15_000_000)
    .regex(/^data:image\/(png|jpe?g|gif|webp);base64,/, 'Must be a base64 image data URL'),
  providerId: z.string().min(1),
  model: z.string().min(1)
});

// Save the appearance analysis as an identity document. Mirrors the import/save
// upsert shape — content is required, title optional.
export const identityImageSaveInputSchema = z.object({
  content: z.string().min(1).max(100000),
  title: z.string().min(1).max(200).optional()
});

// List-based enrichment item
export const listItemSchema = z.object({
  title: z.string().min(1).max(500),
  note: z.string().max(2000).optional()
});

// Analyze list input
export const analyzeListInputSchema = z.object({
  category: enrichmentCategoryEnum,
  items: z.array(listItemSchema).min(1).max(50),
  providerId: z.string().min(1),
  model: z.string().min(1)
});

// Save list document input
export const saveListDocumentInputSchema = z.object({
  category: enrichmentCategoryEnum,
  content: z.string().min(1).max(100000),
  items: z.array(listItemSchema).min(1).max(50)
});

// Get list items input
export const getListItemsInputSchema = z.object({
  category: enrichmentCategoryEnum
});

// --- Input schemas for trait and confidence endpoints ---

// Analyze traits input
export const analyzeTraitsInputSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  forceReanalyze: z.boolean().optional().default(false)
});

// Update traits input (manual override)
export const updateTraitsInputSchema = z.object({
  bigFive: bigFiveSchema.partial().optional(),
  valuesHierarchy: z.array(valuedTraitSchema).max(20).optional(),
  communicationProfile: partialWithoutDefaults(communicationProfileSchema).optional()
});

// Calculate confidence input
export const calculateConfidenceInputSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional()
});

// --- Phase 4: External Data Import Schemas ---

// Import source enum
export const importSourceEnum = z.enum([
  'goodreads',
  'spotify',
  'lastfm',
  'letterboxd',
  'ical'
]);

// Goodreads book entry (parsed from CSV)
export const goodreadsBookSchema = z.object({
  title: z.string(),
  author: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  dateRead: z.string().optional(),
  shelves: z.array(z.string()).optional(),
  review: z.string().optional()
});

// Spotify track/artist entry (parsed from JSON export)
export const spotifyEntrySchema = z.object({
  trackName: z.string().optional(),
  artistName: z.string(),
  albumName: z.string().optional(),
  playCount: z.number().int().optional(),
  msPlayed: z.number().int().optional()
});

// Letterboxd film entry
export const letterboxdFilmSchema = z.object({
  title: z.string(),
  year: z.number().int().optional(),
  rating: z.number().min(0).max(5).optional(),
  watchedDate: z.string().optional(),
  review: z.string().optional(),
  tags: z.array(z.string()).optional()
});

// Calendar event for pattern analysis
export const calendarEventSchema = z.object({
  summary: z.string(),
  start: z.string(),
  end: z.string().optional(),
  recurring: z.boolean().optional(),
  categories: z.array(z.string()).optional()
});

// Import data input (raw data to parse)
export const importDataInputSchema = z.object({
  source: importSourceEnum,
  data: z.string().min(1).max(10000000), // Up to 10MB of text data
  providerId: z.string().min(1),
  model: z.string().min(1)
});

// --- Assessment Analyzer Schema ---

// Analyze assessment input
export const analyzeAssessmentInputSchema = z.object({
  content: z.string().min(50, 'Assessment must be at least 50 characters'),
  providerId: z.string().min(1),
  model: z.string().min(1)
});

// Import analysis result
export const importAnalysisResultSchema = z.object({
  source: importSourceEnum,
  itemCount: z.number().int(),
  insights: z.object({
    patterns: z.array(z.string()).optional(),
    preferences: z.array(z.string()).optional(),
    personalityInferences: z.object({
      bigFive: bigFiveSchema.partial().optional(),
      values: z.array(z.string()).optional(),
      interests: z.array(z.string()).optional()
    }).optional()
  }),
  suggestedDocuments: z.array(z.object({
    filename: z.string(),
    title: z.string(),
    category: documentCategoryEnum,
    content: z.string()
  })).optional(),
  rawSummary: z.string().optional()
});

// --- Taste Questionnaire Schemas ---

export const tasteSectionEnum = z.enum([
  'movies', 'music', 'visual_art', 'architecture', 'food', 'fashion', 'digital'
]);

export const tasteAnswerInputSchema = z.object({
  section: tasteSectionEnum,
  questionId: z.string().min(1),
  answer: z.string().min(1).max(10000),
  source: z.enum(['core', 'follow_up', 'personalized']).optional(),
  generatedQuestion: z.string().max(2000).optional(),
  identityContextUsed: z.array(z.string().max(1000)).max(50).optional()
});

export const tastePersonalizedQuestionInputSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional()
});

export const tasteSummaryInputSchema = z.object({
  section: tasteSectionEnum.optional(),
  providerId: z.string().min(1),
  model: z.string().min(1)
});

// --- Behavioral Feedback Loop Schemas (M34 P3) ---

export const feedbackContentTypeEnum = z.enum([
  'test_response', 'taste_summary', 'enrichment', 'export'
]);

export const feedbackValidationEnum = z.enum([
  'sounds_like_me', 'not_quite', 'doesnt_sound_like_me'
]);

export const feedbackInputSchema = z.object({
  contentType: feedbackContentTypeEnum,
  validation: feedbackValidationEnum,
  contentSnippet: z.string().min(1).max(2000),
  context: z.string().max(500).optional(),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  documentsUsed: z.array(z.string()).optional()
});

// =============================================================================
// TIME CAPSULE SCHEMAS
// =============================================================================

export const createSnapshotInputSchema = z.object({
  label: z.string().min(1).max(200),
  description: z.string().max(1000).optional().default('')
});

export const compareSnapshotsInputSchema = z.object({
  id1: z.string().guid(),
  id2: z.string().guid()
});
