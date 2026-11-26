/**
 * Memory record + retrieval schemas.
 */

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

// Machine-local review metadata, exposed by memory reads but never writable
// through the general memory create/update schemas.
export const memoryReviewOutcomeSchema = z.object({
  expectedVersion: z.number().int().min(1),
  verdict: z.enum(['keep', 'learn', 'archive', 'defer']),
  rationale: z.string().nullable(), lesson: z.string().nullable(), lessonId: memoryIdSchema.nullable(),
  mindId: z.string(), turnId: z.string(), providerId: z.string(), model: z.string(),
  reviewedAt: z.string().datetime(),
});
export const memoryLastReviewSchema = z.object({
  expectedVersion: z.number().int().min(1),
  latestVerdict: z.enum(['keep', 'learn', 'archive', 'defer']),
  outcomes: z.object({
    keep: memoryReviewOutcomeSchema.optional(), learn: memoryReviewOutcomeSchema.optional(),
    archive: memoryReviewOutcomeSchema.optional(), defer: memoryReviewOutcomeSchema.optional(),
  }).strict(),
});

// Full memory schema (includes system-generated fields)
export const memorySchema = memoryCreateSchema.extend({
  id: z.string().guid(),
  version: z.number().int().min(1).optional(),
  lastReview: memoryLastReviewSchema.nullable().optional(),
  reviewOrigin: z.object({
    sourceId: memoryIdSchema, sourceVersion: z.number().int().min(1),
    mindId: z.string(), turnId: z.string(), providerId: z.string(), model: z.string(),
    reviewedAt: z.string().datetime(),
  }).nullable().optional(),
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
  status: memoryStatusEnum.optional(),
  expectedVersion: z.number().int().positive().optional(),
  changedBy: z.string().trim().min(1).max(100).optional(),
  changeReason: z.string().max(2000).optional()
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

// List/filter query schema (GET /api/memory — validated against req.query).
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
  version: z.number().int().positive().optional(),
  syncSequence: z.string().regex(/^\d+$/).optional()
});

export const memorySyncDeletedIdsSchema = z.array(z.object({
  id: z.string().guid(), deletedAt: z.string().datetime()
})).max(1000);

// Sync request body schema
export const memorySyncSchema = z.object({
  memories: z.array(syncMemoryItemSchema).max(1000),
  deletedIds: memorySyncDeletedIdsSchema.optional(),
  schemaVersion: z.number().int().nonnegative().optional()
});

// History is local. The wire version is an explicit receiver capability.
export const memoryVersionQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional()
});
export const memoryVersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});
export const memoryRetireSchema = z.object({
  reason: z.string().max(2000).optional(),
  supersededBy: z.string().guid().optional()
});
export const memoryDeleteQuerySchema = memoryRetireSchema.extend({
  hard: z.enum(['true', 'false']).default('false')
});

export const memorySyncQuerySchema = z.object({
  tombstoneVersion: z.literal('1').optional(),
  since: z.string().regex(/^\d+$/).default('0'),
  limit: z.coerce.number().int().min(1).transform(value => Math.min(value, 1000)).default(100),
  schemaVersion: z.coerce.number().int().nonnegative().optional()
});
