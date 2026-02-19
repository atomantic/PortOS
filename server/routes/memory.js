/**
 * Memory API Routes
 */

import { Router } from 'express';
import * as memory from '../services/memory.js';
import * as embeddings from '../services/memoryEmbeddings.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  memoryCreateSchema,
  memoryUpdateSchema,
  memorySearchSchema,
  memoryListSchema,
  memoryTimelineSchema,
  memoryConsolidateSchema,
  memoryLinkSchema
} from '../lib/memoryValidation.js';

const router = Router();

// GET /api/memory - List memories with filters
router.get('/', asyncHandler(async (req, res) => {
  const options = {
    types: req.query.types ? req.query.types.split(',') : undefined,
    categories: req.query.categories ? req.query.categories.split(',') : undefined,
    tags: req.query.tags ? req.query.tags.split(',') : undefined,
    status: req.query.status || 'active',
    limit: parseInt(req.query.limit) || 50,
    offset: parseInt(req.query.offset) || 0,
    sortBy: req.query.sortBy || 'createdAt',
    sortOrder: req.query.sortOrder || 'desc'
  };

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
  const options = {
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    types: req.query.types ? req.query.types.split(',') : undefined,
    limit: parseInt(req.query.limit) || 100
  };

  const timeline = await memory.getTimeline(options);
  res.json(timeline);
}));

// GET /api/memory/graph - Get graph visualization data
router.get('/graph', asyncHandler(async (req, res) => {
  const graph = await memory.getGraphData();
  res.json(graph);
}));

// GET /api/memory/embeddings/status - Check embedding service status
router.get('/embeddings/status', asyncHandler(async (req, res) => {
  const status = await embeddings.checkAvailability();
  res.json(status);
}));

// POST /api/memory/search - Semantic search
router.post('/search', asyncHandler(async (req, res) => {
  const { query, types, categories, tags, minRelevance, limit, offset } = validateRequest(memorySearchSchema, req.body);

  // Generate query embedding
  const queryEmbedding = await embeddings.generateQueryEmbedding(query, { types, categories });

  if (!queryEmbedding) {
    throw new ServerError('Failed to generate query embedding. Is LM Studio running?', { status: 503 });
  }

  const result = await memory.searchMemories(queryEmbedding, {
    types,
    categories,
    tags,
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
  const { similarityThreshold, dryRun } = validateRequest(memoryConsolidateSchema, req.body);
  const result = await memory.consolidateMemories(similarityThreshold, dryRun);
  res.json(result);
}));

// POST /api/memory/link - Link two memories
router.post('/link', asyncHandler(async (req, res) => {
  const { sourceId, targetId } = validateRequest(memoryLinkSchema, req.body);
  const result = await memory.linkMemories(sourceId, targetId);
  res.json(result);
}));

// POST /api/memory/decay - Apply importance decay
router.post('/decay', asyncHandler(async (req, res) => {
  const decayRate = parseFloat(req.body.decayRate) || 0.01;
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
  const mem = await memory.getMemory(req.params.id);
  if (!mem) {
    throw new ServerError('Memory not found', { status: 404 });
  }
  res.json(mem);
}));

// GET /api/memory/:id/related - Get related memories
router.get('/:id/related', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const related = await memory.getRelatedMemories(req.params.id, limit);
  res.json(related);
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
  const result = await memory.rejectMemory(req.params.id);
  if (!result.success) {
    throw new ServerError(result.error, { status: result.error === 'Memory not found' ? 404 : 400 });
  }
  res.json(result);
}));

// DELETE /api/memory/:id - Delete a memory
router.delete('/:id', asyncHandler(async (req, res) => {
  const hard = req.query.hard === 'true';
  const result = await memory.deleteMemory(req.params.id, hard);
  res.json(result);
}));

export default router;
