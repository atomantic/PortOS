import { z } from 'zod';

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
  relatedMemories: z.array(z.string().uuid()).optional().default([]),
  sourceTaskId: z.string().optional(),
  sourceAgentId: z.string().optional()
});

// Full memory schema (includes system-generated fields)
export const memorySchema = memoryCreateSchema.extend({
  id: z.string().uuid(),
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
export const memoryUpdateSchema = memoryCreateSchema.partial().extend({
  status: memoryStatusEnum.optional()
});

// Search query schema
export const memorySearchSchema = z.object({
  query: z.string().min(1).max(1000),
  types: z.array(memoryTypeEnum).optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: memoryStatusEnum.optional().default('active'),
  minRelevance: z.number().min(0).max(1).optional().default(0.7),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0)
});

// List/filter query schema
export const memoryListSchema = z.object({
  types: z.array(memoryTypeEnum).optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: memoryStatusEnum.optional().default('active'),
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
  sortBy: z.enum(['createdAt', 'updatedAt', 'importance', 'accessCount']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc')
});

// Timeline query schema
export const memoryTimelineSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  types: z.array(memoryTypeEnum).optional(),
  limit: z.number().int().min(1).max(500).optional().default(100)
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
  sourceId: z.string().uuid(),
  targetId: z.string().uuid()
});
