import { z } from 'zod';

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
  'error_intolerance'
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

// Test history entry schema
export const testHistoryEntrySchema = z.object({
  runId: z.string().uuid(),
  providerId: z.string(),
  model: z.string(),
  score: z.number().min(0).max(1),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  partial: z.number().int().min(0),
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
  questionsAnswered: z.record(enrichmentCategoryEnum, z.number().int().min(0)).optional()
});

// Soul settings schema
export const soulSettingsSchema = z.object({
  autoInjectToCoS: z.boolean().default(true),
  maxContextTokens: z.number().int().min(1000).max(100000).default(4000)
});

// Full meta.json schema
export const soulMetaSchema = z.object({
  version: z.string().default('1.0.0'),
  documents: z.array(documentMetaSchema).default([]),
  testHistory: z.array(testHistoryEntrySchema).default([]),
  enrichment: enrichmentProgressSchema.default({ completedCategories: [], lastSession: null }),
  settings: soulSettingsSchema.default({ autoInjectToCoS: true, maxContextTokens: 4000 })
});

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

// Run tests input
export const runTestsInputSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  testIds: z.array(z.number().int().min(1)).optional()
});

// Run multi-model tests input
export const runMultiTestsInputSchema = z.object({
  providers: z.array(z.object({
    providerId: z.string().min(1),
    model: z.string().min(1)
  })).min(1).max(10),
  testIds: z.array(z.number().int().min(1)).optional()
});

// Enrichment question input
export const enrichmentQuestionInputSchema = z.object({
  category: enrichmentCategoryEnum,
  providerOverride: z.string().optional(),
  modelOverride: z.string().optional()
});

// Enrichment answer input
export const enrichmentAnswerInputSchema = z.object({
  questionId: z.string().uuid(),
  category: enrichmentCategoryEnum,
  question: z.string().min(1),
  answer: z.string().min(1).max(10000),
  providerOverride: z.string().optional(),
  modelOverride: z.string().optional()
});

// Export input
export const exportInputSchema = z.object({
  format: exportFormatEnum,
  documentIds: z.array(z.string()).optional(),
  includeDisabled: z.boolean().optional().default(false)
});

// Settings update input
export const settingsUpdateInputSchema = soulSettingsSchema.partial();

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
