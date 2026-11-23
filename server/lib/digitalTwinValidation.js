/**
 * Digital twin route request schemas. Persistence/domain schemas live in
 * `digitalTwinSchemas.js` so services don't pull route schemas into their graph.
 */

import { z } from 'zod';
import { partialWithoutDefaults } from './zodCompat.js';
import {
  documentCategoryEnum,
  exportFormatEnum,
  enrichmentCategoryEnum,
  listItemSchema,
  documentFilenameSchema,
  soulSettingsSchema,
  bigFiveSchema,
  valuedTraitSchema,
  communicationProfileSchema,
} from './digitalTwinSchemas.js';

export * from './digitalTwinSchemas.js';

// --- Input schemas for API endpoints ---

// Create document input
export const createDocumentInputSchema = z.object({
  filename: documentFilenameSchema.max(100).regex(/^[\w\-]+\.md$/, 'Filename must be a valid markdown filename'),
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

// Optional client-minted batch id, echoed on every `digital-twin:test-progress`
// frame so a run can tell its own progress from another run's. Absent for
// callers that only read the final response array.
const optionalRequestId = z.preprocess(
  v => (v == null || v === '') ? undefined : v,
  z.string().min(1).max(100).optional()
);

// Run multi-model tests input
export const runMultiTestsInputSchema = z.object({
  providers: z.array(z.object({
    providerId: z.string().min(1),
    model: z.string().min(1)
  })).min(1).max(10),
  testIds: optionalTestIds,
  personaId: optionalPersonaId,
  requestId: optionalRequestId
});

// Enrichment question input
export const enrichmentQuestionInputSchema = z.object({
  category: enrichmentCategoryEnum,
  providerOverride: z.string().optional(),
  modelOverride: z.string().optional(),
  skipIndices: z.array(z.number().int()).optional(),
  // Serve only predefined/scale questions; answer { exhausted: true } instead
  // of calling a provider once they run out (an automatic load, #14445).
  structuredOnly: z.boolean().optional()
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

// Live Avatar Bio — length preset shared by the deterministic build and the
// optional LLM polish. Kept in sync with AVATAR_BIO_LENGTHS in the service.
export const avatarBioLengthEnum = z.enum(['blurb', 'persona', 'knowledge']);

// Optional length query for the deterministic GET (defaults to 'persona').
export const avatarBioQuerySchema = z.object({
  length: avatarBioLengthEnum.optional().default('persona')
});

// LLM-polish input — explicit user-triggered provider call.
export const avatarBioPolishInputSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  length: avatarBioLengthEnum.optional().default('persona')
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

// GET /feedback/recent — scalars only; parsePagination keeps the lenient limit fallback.
export const feedbackRecentQuerySchema = z.object({
  contentType: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
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

// =============================================================================
// TWIN ENRICHMENT SCHEMAS (Phase 7, #2156)
// Observed-behavior taste + chronotype evidence. Recompute is LLM-free (empty
// body); interpret is an explicit user-triggered provider call.
// =============================================================================

// Recompute the LLM-free rollups. No inputs — the body is ignored, but validate
// it as an (optionally empty) object so a stray payload is rejected cleanly.
export const twinEvidenceRecomputeInputSchema = z.object({}).strict().optional().default({});

// "What does my consumption say about me" — explicit provider call.
export const twinEvidenceInterpretInputSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1).optional()
});
