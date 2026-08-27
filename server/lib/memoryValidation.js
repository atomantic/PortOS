import { z } from 'zod';
import { partialWithoutDefaults } from './zodCompat.js';

// Memory ids are directory names in the file-backed store. Keep route input
// constrained to one plain path segment before it reaches any filesystem code.
export const memoryIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);
export const memoryIdParamSchema = z.object({ id: memoryIdSchema });

// Memory types enum
export const memoryTypeEnum = z.enum([
  'fact',
  'learning',
  'observation',
  'decision',
  'preference',
  'context'
]);

// Memory status enum
export const memoryStatusEnum = z.enum(['active', 'archived', 'expired', 'pending_approval']);

// Memory category enum (extensible, but common ones)
export const memoryCategoryEnum = z.enum([
  'codebase',
  'workflow',
  'tools',
  'architecture',
  'patterns',
  'conventions',
  'preferences',
  'system',
  'project',
  'other'
]);

// Core memory schema for creation
export const memoryCreateSchema = z.object({
  type: memoryTypeEnum,
  content: z.string().min(1).max(10240),
  summary: z.string().max(500).optional(),
  category: z.string().min(1).max(100).optional().default('other'),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  confidence: z.number().min(0).max(1).optional().default(0.8),
  importance: z.number().min(0).max(1).optional().default(0.5),
  relatedMemories: z.array(z.string().guid()).optional().default([]),
  sourceTaskId: z.string().optional(),
  sourceAgentId: z.string().optional(),
  sourceAppId: z.string().nullable().optional()
});

// Full memory schema (includes system-generated fields)
export const memorySchema = memoryCreateSchema.extend({
  id: z.string().guid(),
  embedding: z.array(z.number()).optional(),
  embeddingModel: z.string().optional(),
  accessCount: z.number().int().min(0).default(0),
  lastAccessed: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable().optional(),
  status: memoryStatusEnum.default('active')
});

// Partial schema for updates
export const memoryUpdateSchema = partialWithoutDefaults(memoryCreateSchema).extend({
  status: memoryStatusEnum.optional()
});

// Search query schema
export const memorySearchSchema = z.object({
  query: z.string().min(1).max(1000),
  types: z.array(memoryTypeEnum).optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: memoryStatusEnum.optional().default('active'),
  appId: z.string().max(100).optional(),
  minRelevance: z.number().min(0).max(1).optional().default(0.7),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0)
});

// ---------------------------------------------------------------------------
// Query-string coercion
//
// The list/timeline schemas below validate `req.query`, where every value
// arrives as a string: arrays are comma-separated (`?types=fact,learning`, the
// shape `client/src/services/apiMemory.js` sends) and numbers are digits. These
// preprocessors accept both the query form and the already-parsed form so the
// same schema still validates a JSON body. An empty param (`?types=`) becomes
// `undefined` — "not filtered" — rather than an empty list or a NaN.
// ---------------------------------------------------------------------------

const csvList = (inner) => z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}, inner);

const numeric = (inner) => z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : v;
}, inner);

const emptyToUndefined = (inner) => z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  inner
);

// A `YYYY-MM-DD` string can match the shape and still name a day that doesn't
// exist (`2026-02-30`). `Date.parse` rolls those over instead of failing, so
// round-trip the parts — otherwise Postgres is the one that rejects the date,
// as a 500 rather than a 400.
const isRealCalendarDate = (v) => {
  const [year, month, day] = v.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC maps a 0-99 year onto 1900-1999; re-set it so a year like 0026
  // compares against itself rather than 1926.
  parsed.setUTCFullYear(year);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
};

// `startDate`/`endDate` reach Postgres as `created_at >= $n` bind params, so a
// bare calendar date is as usable as a full timestamp — accept either. The
// datetime branch allows a `+HH:MM` offset, not just a `Z` suffix, since either
// is a legitimate serialization of the same instant. A bare date means midnight
// at both ends of the range, matching how these bounds have always been read —
// pass a full timestamp to include part of a day.
const dateBoundary = z.union([
  z.string().datetime({ offset: true }),
  z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO datetime or YYYY-MM-DD date')
    .refine(isRealCalendarDate, 'must be a real calendar date')
]);

// List/filter query schema (GET /api/memory — validated against req.query).
// `limit` caps at 500 to match the timeline schema and the ceiling this route
// has always enforced via parsePagination's maxLimit.
export const memoryListSchema = z.object({
  types: csvList(z.array(memoryTypeEnum).optional()),
  categories: csvList(z.array(z.string().max(100)).optional()),
  tags: csvList(z.array(z.string().max(50)).optional()),
  status: emptyToUndefined(memoryStatusEnum.optional().default('active')),
  appId: emptyToUndefined(z.string().max(100).optional()),
  sourceAgentId: emptyToUndefined(z.string().max(128).optional()),
  limit: numeric(z.number().int().min(1).max(500).optional().default(50)),
  offset: numeric(z.number().int().min(0).optional().default(0)),
  sortBy: emptyToUndefined(z.enum(['createdAt', 'updatedAt', 'importance', 'accessCount']).optional().default('createdAt')),
  sortOrder: emptyToUndefined(z.enum(['asc', 'desc']).optional().default('desc'))
});

// Timeline query schema (GET /api/memory/timeline — validated against req.query)
export const memoryTimelineSchema = z.object({
  startDate: emptyToUndefined(dateBoundary.optional()),
  endDate: emptyToUndefined(dateBoundary.optional()),
  types: csvList(z.array(memoryTypeEnum).optional()),
  // Both timeline backends filter on appId (including the `__not_brain`
  // sentinel the CoS Memory tab uses); it was unreachable while the handler
  // hand-built its options object.
  appId: emptyToUndefined(z.string().max(100).optional()),
  limit: numeric(z.number().int().min(1).max(500).optional().default(100))
});

// Memory extraction request schema (from agent output)
export const memoryExtractSchema = z.object({
  agentId: z.string(),
  taskId: z.string(),
  output: z.string().min(1)
});

// Memory consolidation request schema
export const memoryConsolidateSchema = z.object({
  similarityThreshold: z.number().min(0.5).max(1).optional().default(0.9),
  dryRun: z.boolean().optional().default(false)
});

// Link memories request schema
export const memoryLinkSchema = z.object({
  sourceId: z.string().guid(),
  targetId: z.string().guid()
});

// Single sync memory item schema (incoming from remote peer)
const syncMemoryItemSchema = z.object({
  id: z.string().guid(),
  type: memoryTypeEnum,
  content: z.string().min(1).max(10240),
  summary: z.string().max(500).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  tags: z.array(z.string().max(50)).optional().default([]),
  embedding: z.array(z.number()).length(768).nullable().optional(),
  embeddingModel: z.string().max(200).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  importance: z.number().min(0).max(1).nullable().optional(),
  status: memoryStatusEnum.optional().default('active'),
  sourceTaskId: z.string().nullable().optional(),
  sourceAgentId: z.string().nullable().optional(),
  sourceAppId: z.string().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  originInstanceId: z.string().max(36).nullable().optional(),
  syncSequence: z.string().regex(/^\d+$/).optional()
});

// Sync request body schema
export const memorySyncSchema = z.object({
  memories: z.array(syncMemoryItemSchema).max(1000)
});
