/**
 * Memory API Routes
 */

import { Router } from 'express';
import * as memory from '../services/memoryBackend.js';
import { ensureBackend } from '../services/memoryBackend.js';
import * as embeddings from '../services/memoryEmbeddings.js';
import * as memorySync from '../services/memorySync.js';
import { findRecentRunsUsingMemory } from '../services/memoryRunUsage.js';
import { checkHealth } from '../lib/db.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, parsePagination } from '../lib/validation.js';
import {
  memoryCreateSchema,
  memoryUpdateSchema,
  memorySearchSchema,
  memoryListSchema,
  memoryTimelineSchema,
  memoryConsolidateSchema,
  memoryDecaySchema,
  memoryLinkSchema,
  memorySyncSchema,
  memoryIdParamSchema,
  memoryVersionQuerySchema,
  memoryVersionsQuerySchema,
  memoryRetireSchema,
  memoryDeleteQuerySchema,
  memorySyncQuerySchema
} from '../lib/memoryValidation.js';

const router = Router();

// GET /api/memory - List memories with filters
router.get('/', asyncHandler(async (req, res) => {
  const options = validateRequest(memoryListSchema, req.query);

  const result = await memory.getMemories(options);
  res.json(result);
}));

// GET /api/memory/stats - Get memory statistics
router.get('/stats', asyncHandler(async (req, res) => {
  const stats = await memory.getStats();
  res.json(stats);
}));

// GET /api/memory/categories - Get all categories
router.get('/categories', asyncHandler(async (req, res) => {
  const categories = await memory.getCategories();
  res.json(categories);
}));

// GET /api/memory/tags - Get all tags
router.get('/tags', asyncHandler(async (req, res) => {
  const tags = await memory.getTags();
  res.json(tags);
}));

// GET /api/memory/timeline - Get timeline view
router.get('/timeline', asyncHandler(async (req, res) => {
  const options = validateRequest(memoryTimelineSchema, req.query);

  const timeline = await memory.getTimeline(options);
  res.json(timeline);
}));

// GET /api/memory/graph - Get graph visualization data
router.get('/graph', asyncHandler(async (req, res) => {
  const graph = await memory.getGraphData();
  res.json(graph);
}));

// GET /api/memory/backend/status - Check memory backend status
router.get('/backend/status', asyncHandler(async (req, res) => {
  const name = await ensureBackend();
  const dbHealth = await checkHealth();
  res.json({ backend: name, db: dbHealth });
}));

// GET /api/memory/sync - Federation sync: get changes since sequence
router.get('/sync', asyncHandler(async (req, res) => {
  const name = await ensureBackend();
  if (name !== 'postgres') {
    throw new ServerError('Sync requires PostgreSQL backend', { status: 400 });
  }
  const { since, limit, schemaVersion } = validateRequest(memorySyncQuerySchema, req.query);
  const result = schemaVersion === undefined
    ? await memorySync.getChangesSince(since, limit)
    : await memorySync.getChangesSince(since, limit, schemaVersion);
  res.json(result);
}));

// POST /api/memory/sync - Federation sync: apply remote changes
router.post('/sync', asyncHandler(async (req, res) => {
  const name = await ensureBackend();
  if (name !== 'postgres') {
    throw new ServerError('Sync requires PostgreSQL backend', { status: 400 });
  }
  const { memories, schemaVersion } = validateRequest(memorySyncSchema, req.body);
  const result = schemaVersion === undefined
    ? await memorySync.applyRemoteChanges(memories)
    : await memorySync.applyRemoteChanges(memories, schemaVersion);
  res.json(result);
}));

// GET /api/memory/embeddings/status - Check embedding service status
router.get('/embeddings/status', asyncHandler(async (req, res) => {
  const status = await embeddings.checkAvailability();
  res.json(status);
}));

// POST /api/memory/search - Semantic search
router.post('/search', asyncHandler(async (req, res) => {
  const { query, types, categories, tags, appId, minRelevance, limit, offset } = validateRequest(memorySearchSchema, req.body);

  // Generate query embedding
  const queryEmbedding = await embeddings.generateQueryEmbedding(query, { types, categories });

  if (!queryEmbedding) {
    throw new ServerError('Failed to generate query embedding. Is LM Studio running?', { status: 503 });
  }

  const result = await memory.searchMemories(queryEmbedding, {
    types,
    categories,
    tags,
    appId,
    minRelevance,
    limit,
    offset
  });

  res.json(result);
}));

// POST /api/memory - Create a new memory
router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryCreateSchema, req.body);

  // Generate embedding for the memory
  const embedding = await embeddings.generateMemoryEmbedding(data);

  const created = await memory.createMemory(data, embedding);
  res.status(201).json(created);
}));

// POST /api/memory/consolidate - Consolidate similar memories
router.post('/consolidate', asyncHandler(async (req, res) => {
  const { similarityThreshold, dryRun, reason } = validateRequest(memoryConsolidateSchema, req.body);
  const result = await memory.consolidateMemories(similarityThreshold, dryRun, { reason });
  res.json(result);
}));

// POST /api/memory/link - Link two memories
router.post('/link', asyncHandler(async (req, res) => {
  const { sourceId, targetId, linkType, note, createdBy } = validateRequest(memoryLinkSchema, req.body);
  const result = await memory.linkMemories(sourceId, targetId, { linkType, note, createdBy });
  res.json(result);
}));

// POST /api/memory/decay - Apply importance decay
router.post('/decay', asyncHandler(async (req, res) => {
  const { decayRate } = validateRequest(memoryDecaySchema, req.body ?? {});
  const result = await memory.applyDecay(decayRate);
  res.json(result);
}));

// DELETE /api/memory/expired - Clear expired memories
router.delete('/expired', asyncHandler(async (req, res) => {
  const result = await memory.clearExpired();
  res.json(result);
}));

// GET /api/memory/:id - Get a single memory
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(memoryIdParamSchema, req.params);
  const { version } = validateRequest(memoryVersionQuerySchema, req.query);
  const mem = version === undefined ? await memory.getMemory(id) : await memory.getMemoryVersion(id, version);
  if (!mem) {
    throw new ServerError('Memory not found', { status: 404 });
  }
  res.json(mem);
}));

// GET /api/memory/:id/versions - Bounded history metadata, newest first
router.get('/:id/versions', asyncHandler(async (req, res) => {
  const { id } = validateRequest(memoryIdParamSchema, req.params);
  const options = validateRequest(memoryVersionsQuerySchema, req.query);
  res.json({ versions: await memory.getMemoryVersions(id, options) });
}));

// GET /api/memory/:id/related - Get related memories
router.get('/:id/related', asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 500 });
  const related = await memory.getRelatedMemories(req.params.id, limit);
  res.json(related);
}));

// GET /api/memory/:id/runs - Recent agent runs whose prompt included this memory
router.get('/:id/runs', asyncHandler(async (req, res) => {
  const { id } = validateRequest(memoryIdParamSchema, req.params);
  res.json({ runs: await findRecentRunsUsingMemory(id) });
}));

// PUT /api/memory/:id - Update a memory
router.put('/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryUpdateSchema, req.body);
  const updated = await memory.updateMemory(req.params.id, data);
  if (!updated) {
    throw new ServerError('Memory not found', { status: 404 });
  }

  // Regenerate embedding if content changed
  if (data.content) {
    const embedding = await embeddings.generateMemoryEmbedding(updated);
    if (embedding) {
      await memory.updateMemoryEmbedding(updated.id, embedding);
    }
  }

  res.json(updated);
}));

// POST /api/memory/:id/approve - Approve a pending memory
router.post('/:id/approve', asyncHandler(async (req, res) => {
  const result = await memory.approveMemory(req.params.id);
  if (!result.success) {
    throw new ServerError(result.error, { status: result.error === 'Memory not found' ? 404 : 400 });
  }
  res.json(result);
}));

// POST /api/memory/:id/reject - Reject a pending memory
router.post('/:id/reject', asyncHandler(async (req, res) => {
  const options = validateRequest(memoryRetireSchema, req.body ?? {});
  const result = await memory.rejectMemory(req.params.id, options);
  if (!result.success) {
    throw new ServerError(result.error, { status: result.error === 'Memory not found' ? 404 : 400 });
  }
  res.json(result);
}));

// DELETE /api/memory/:id - Delete a memory
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(memoryIdParamSchema, req.params);
  const { hard, ...options } = validateRequest(memoryDeleteQuerySchema, req.query);
  const result = await (hard === 'true' ? memory.purgeMemory(id) : memory.archiveMemory(id, options));
  res.json(result);
}));

export default router;
