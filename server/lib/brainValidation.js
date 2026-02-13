import { z } from 'zod';

// Destination enum
export const destinationEnum = z.enum(['people', 'projects', 'ideas', 'admin', 'unknown']);

// Project status enum
export const projectStatusEnum = z.enum(['active', 'waiting', 'blocked', 'someday', 'done']);

// Admin status enum
export const adminStatusEnum = z.enum(['open', 'waiting', 'done']);

// Inbox log status enum
export const inboxStatusEnum = z.enum(['classifying', 'filed', 'needs_review', 'corrected', 'done', 'error']);

// AI configuration schema
export const aiConfigSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  promptTemplateId: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional()
});

// Classification result schema
export const classificationSchema = z.object({
  destination: destinationEnum,
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(200),
  extracted: z.record(z.unknown()),
  reasons: z.array(z.string()).max(5).optional()
});

// Filed info schema
export const filedSchema = z.object({
  destination: destinationEnum.exclude(['unknown']),
  destinationId: z.string().uuid()
});

// Correction schema
export const correctionSchema = z.object({
  correctedAt: z.string().datetime(),
  previousDestination: destinationEnum,
  newDestination: destinationEnum.exclude(['unknown']),
  note: z.string().max(500).optional()
});

// Error schema
export const errorSchema = z.object({
  message: z.string(),
  stack: z.string().optional()
});

// Inbox Log Record schema
export const inboxLogRecordSchema = z.object({
  id: z.string().uuid(),
  capturedText: z.string().min(1).max(10000),
  capturedAt: z.string().datetime(),
  source: z.literal('brain_ui'),
  ai: aiConfigSchema.optional(),
  classification: classificationSchema.optional(),
  status: inboxStatusEnum,
  filed: filedSchema.optional(),
  correction: correctionSchema.optional(),
  error: errorSchema.optional()
});

// People Record schema
export const peopleRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  context: z.string().max(2000).optional().default(''),
  followUps: z.array(z.string().max(500)).optional().default([]),
  lastTouched: z.string().datetime().optional(),
  tags: z.array(z.string().max(50)).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Project Record schema
export const projectRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  status: projectStatusEnum,
  nextAction: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Idea Record schema
export const ideaRecordSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  oneLiner: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Admin Record schema
export const adminRecordSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  status: adminStatusEnum,
  dueDate: z.string().datetime().optional(),
  nextAction: z.string().max(500).optional(),
  notes: z.string().max(5000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Meta/Settings schema
export const brainSettingsSchema = z.object({
  version: z.number().int().positive().default(1),
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  dailyDigestTime: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  weeklyReviewTime: z.string().regex(/^\d{2}:\d{2}$/).default('16:00'),
  weeklyReviewDay: z.enum(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']).default('sunday'),
  defaultProvider: z.string().default('lmstudio'),
  defaultModel: z.string().default('gptoss-20b'),
  lastDailyDigest: z.string().datetime().optional(),
  lastWeeklyReview: z.string().datetime().optional()
});

// Digest Record schema
export const digestRecordSchema = z.object({
  id: z.string().uuid(),
  generatedAt: z.string().datetime(),
  digestText: z.string().max(2000),
  topActions: z.array(z.string().max(200)).max(3),
  stuckThing: z.string().max(200),
  smallWin: z.string().max(200),
  ai: aiConfigSchema.optional()
});

// Weekly Review Record schema
export const reviewRecordSchema = z.object({
  id: z.string().uuid(),
  generatedAt: z.string().datetime(),
  reviewText: z.string().max(3000),
  whatHappened: z.array(z.string().max(200)).max(5),
  biggestOpenLoops: z.array(z.string().max(200)).max(3),
  suggestedActionsNextWeek: z.array(z.string().max(200)).max(3),
  recurringTheme: z.string().max(500),
  ai: aiConfigSchema.optional()
});

// --- Input schemas for API endpoints ---

// Capture input schema
export const captureInputSchema = z.object({
  text: z.string().min(1).max(10000),
  providerOverride: z.string().optional(),
  modelOverride: z.string().optional()
});

// Resolve review input schema
export const resolveReviewInputSchema = z.object({
  inboxLogId: z.string().uuid(),
  destination: destinationEnum.exclude(['unknown']),
  editedExtracted: z.record(z.unknown()).optional()
});

// Fix classification input schema
export const fixInputSchema = z.object({
  inboxLogId: z.string().uuid(),
  newDestination: destinationEnum.exclude(['unknown']),
  updatedFields: z.record(z.unknown()).optional(),
  note: z.string().max(500).optional()
});

// Update inbox entry input schema
export const updateInboxInputSchema = z.object({
  capturedText: z.string().min(1).max(10000)
});

// Create/Update People input schema
export const peopleInputSchema = z.object({
  name: z.string().min(1).max(200),
  context: z.string().max(2000).optional(),
  followUps: z.array(z.string().max(500)).optional(),
  lastTouched: z.string().datetime().optional(),
  tags: z.array(z.string().max(50)).optional()
});

// Create/Update Project input schema
export const projectInputSchema = z.object({
  name: z.string().min(1).max(200),
  status: projectStatusEnum.optional().default('active'),
  nextAction: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).optional()
});

// Create/Update Idea input schema
export const ideaInputSchema = z.object({
  title: z.string().min(1).max(200),
  oneLiner: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).optional()
});

// Create/Update Admin input schema
export const adminInputSchema = z.object({
  title: z.string().min(1).max(200),
  status: adminStatusEnum.optional().default('open'),
  dueDate: z.string().datetime().optional(),
  nextAction: z.string().max(500).optional(),
  notes: z.string().max(5000).optional()
});

// Settings update input schema
export const settingsUpdateInputSchema = brainSettingsSchema.partial().omit({ version: true, lastDailyDigest: true, lastWeeklyReview: true });

// Inbox query schema
export const inboxQuerySchema = z.object({
  status: inboxStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0)
});

// --- Extracted field schemas for AI classification ---

// Extracted People fields
export const extractedPeopleSchema = z.object({
  name: z.string().min(1).max(200),
  context: z.string().max(2000).optional().default(''),
  followUps: z.array(z.string().max(500)).optional().default([]),
  lastTouched: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(50)).optional().default([])
});

// Extracted Project fields
export const extractedProjectSchema = z.object({
  name: z.string().min(1).max(200),
  status: projectStatusEnum.optional().default('active'),
  nextAction: z.string().min(1).max(500),
  notes: z.string().max(5000).optional().default(''),
  tags: z.array(z.string().max(50)).optional().default([])
});

// Extracted Idea fields
export const extractedIdeaSchema = z.object({
  title: z.string().min(1).max(200),
  oneLiner: z.string().min(1).max(500),
  notes: z.string().max(5000).optional().default(''),
  tags: z.array(z.string().max(50)).optional().default([])
});

// Extracted Admin fields
export const extractedAdminSchema = z.object({
  title: z.string().min(1).max(200),
  status: adminStatusEnum.optional().default('open'),
  dueDate: z.string().datetime().nullable().optional(),
  nextAction: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).optional().default('')
});

// AI Classifier output schema (what we expect from the AI)
export const classifierOutputSchema = z.object({
  destination: destinationEnum,
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(200),
  extracted: z.record(z.unknown()),
  reasons: z.array(z.string()).max(5).optional().default([])
});

// Daily digest AI output schema
export const digestOutputSchema = z.object({
  digestText: z.string(),
  topActions: z.array(z.string()).max(3),
  stuckThing: z.string(),
  smallWin: z.string()
});

// Weekly review AI output schema
export const reviewOutputSchema = z.object({
  reviewText: z.string(),
  whatHappened: z.array(z.string()).max(5),
  biggestOpenLoops: z.array(z.string()).max(3),
  suggestedActionsNextWeek: z.array(z.string()).max(3),
  recurringTheme: z.string()
});

// =============================================================================
// LINKS SCHEMAS
// =============================================================================

// Link type enum
export const linkTypeEnum = z.enum(['github', 'article', 'documentation', 'tool', 'reference', 'other']);

// Link Record schema
export const linkRecordSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional().default(''),
  linkType: linkTypeEnum.default('other'),
  tags: z.array(z.string().max(50)).optional().default([]),
  // GitHub-specific fields
  isGitHubRepo: z.boolean().default(false),
  gitHubOwner: z.string().max(100).optional(),
  gitHubRepo: z.string().max(100).optional(),
  localPath: z.string().max(500).optional(),
  cloneStatus: z.enum(['pending', 'cloning', 'cloned', 'failed', 'none']).default('none'),
  cloneError: z.string().max(500).optional(),
  // Metadata
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Create/Update Link input schema
export const linkInputSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).optional(),
  linkType: linkTypeEnum.optional(),
  tags: z.array(z.string().max(50)).optional(),
  autoClone: z.boolean().optional().default(true)
});

// Update Link input schema (partial)
export const linkUpdateInputSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).optional(),
  linkType: linkTypeEnum.optional(),
  tags: z.array(z.string().max(50)).optional()
});

// Links query schema
export const linksQuerySchema = z.object({
  linkType: linkTypeEnum.optional(),
  isGitHubRepo: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0)
});
